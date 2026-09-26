import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Ban,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MapPin,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n/i18n";
import type { Subject } from "../../types";
import { useAuth } from "../../contexts/AuthContext";
import type { PlanningCalendarBlock as PlanningCalendarBlockRow, PlanningException, PlanningSeries, PlanningSeriesOverrides } from "../../types";
import type { TranslationKey } from "../../i18n/translations";
import { api } from "../../api";
import { subjectColors } from "../SubjectEditor";
import { normalizeSubjectIcon, subjectIconOptions } from "../SubjectIcon";
import "./planning.css";

type ViewMode = "day" | "week" | "month";
type Recurrence = "weekly" | "even" | "odd" | "once";
type WeekPattern = "all" | "even" | "odd";
type IconKey = (typeof subjectIconOptions)[number]["name"];
type ColorKey = (typeof subjectColors)[number]["value"];
type CalendarBlock = { id: number | string; kind: "break" | "holiday"; name?: string; startsOn: string; endsOn: string };
type EventPatch = Partial<Pick<ScheduleEvent, "title" | "teacher" | "room" | "startTime" | "endTime" | "color" | "icon" | "subjectId">> & { exceptionId?: number; exceptionStatus?: "cancelled" | "modified"; overrideDate?: string | null };
type ScheduleEvent = {
  id: number;
  yearId: number;
  startsOn: string;
  endsOn: string | null;
  title: string;
  subjectId: number | null;
  date: string | null;
  teacher: string;
  room: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  recurrence: Recurrence;
  weekPattern: WeekPattern;
  color: ColorKey;
  icon: IconKey;
  cancelled: boolean;
  cancelledDates: string[];
  exceptions: Record<string, EventPatch>;
};
type Occurrence = {
  event: ScheduleEvent;
  occurrenceDate: string;
  date: string;
  title: string;
  teacher: string;
  room: string;
  startTime: string;
  endTime: string;
  color: ColorKey;
  icon: IconKey;
  cancelled: boolean;
};
type SchoolYear = { id: number | null; name: string; startsOn: string; endsOn: string; timeZone: string; blocks: CalendarBlock[] };
type PlanningState = { schoolYear: SchoolYear; events: ScheduleEvent[] };
type EventFormValues = Omit<ScheduleEvent, "id" | "yearId" | "startsOn" | "endsOn" | "cancelled" | "cancelledDates" | "exceptions">;
type ModalState =
  | { kind: "create" }
  | { kind: "details"; occurrence: Occurrence }
  | { kind: "edit-scope"; occurrence: Occurrence }
  | { kind: "edit"; occurrence: Occurrence; scope: "series" | "occurrence" }
  | { kind: "settings" }
  | null;
type PlanningTranslate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const GRID_START_HOUR = 7;
const GRID_END_HOUR = 20;
const HOUR_HEIGHT = 76;
const DAY_NAMES = ["planning.monday", "planning.tuesday", "planning.wednesday", "planning.thursday", "planning.friday", "planning.saturday", "planning.sunday"] as const;
const emptyPlanningState: PlanningState = { schoolYear: { id: null, name: "Année scolaire", startsOn: "", endsOn: "", timeZone: "UTC", blocks: [] }, events: [] };
const defaultSubjectColor = subjectColors.find((color) => color.value === "#3B82F6")?.value ?? subjectColors[0].value;

function createPlanningId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function exceptionPatchFromRow(exception: PlanningException): EventPatch {
  const overrides = exception.overrides;
  return {
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
    ...(overrides.subject_id === undefined ? {} : { subjectId: overrides.subject_id }),
    ...(overrides.teacher === undefined ? {} : { teacher: overrides.teacher ?? "" }),
    ...(overrides.room === undefined ? {} : { room: overrides.room ?? "" }),
    ...(overrides.start_time === undefined ? {} : { startTime: overrides.start_time }),
    ...(overrides.end_time === undefined ? {} : { endTime: overrides.end_time }),
    ...(overrides.color_key === undefined ? {} : { color: (subjectColors.find((color) => color.value.toLowerCase() === overrides.color_key?.toLowerCase())?.value ?? defaultSubjectColor) as ColorKey }),
    ...(overrides.icon_key === undefined ? {} : { icon: (subjectIconOptions.find((option) => option.name === normalizeSubjectIcon(overrides.icon_key))?.name ?? "book") as IconKey }),
    exceptionId: exception.id,
    exceptionStatus: exception.status,
    overrideDate: exception.override_date,
  };
}

function eventPatchToOverrides(patch: EventPatch): PlanningSeriesOverrides {
  return {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.subjectId === undefined ? {} : { subject_id: patch.subjectId }),
    ...(patch.teacher === undefined ? {} : { teacher: patch.teacher || null }),
    ...(patch.room === undefined ? {} : { room: patch.room || null }),
    ...(patch.startTime === undefined ? {} : { start_time: patch.startTime }),
    ...(patch.endTime === undefined ? {} : { end_time: patch.endTime }),
    ...(patch.color === undefined ? {} : { color_key: patch.color }),
    ...(patch.icon === undefined ? {} : { icon_key: patch.icon }),
  };
}

function eventFromRow(row: PlanningSeries, exceptions: PlanningException[]): ScheduleEvent {
  const eventExceptions = Object.fromEntries(exceptions.map((exception) => [exception.occurrence_date, exceptionPatchFromRow(exception)]));
  const recurrence: Recurrence = row.recurrence === "once" ? "once" : row.week_pattern === "all" ? "weekly" : row.week_pattern;
  const color = subjectColors.find((option) => option.value.toLowerCase() === row.color_key?.toLowerCase())?.value ?? defaultSubjectColor;
  const icon = subjectIconOptions.find((option) => option.name === normalizeSubjectIcon(row.icon_key))?.name ?? "book";
  return {
    id: row.id,
    yearId: row.year_id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    title: row.title,
    subjectId: row.subject_id,
    date: row.recurrence === "once" ? row.starts_on : null,
    teacher: row.teacher ?? "",
    room: row.room ?? "",
    dayOfWeek: row.day_of_week,
    startTime: row.start_time.slice(0, 5),
    endTime: row.end_time.slice(0, 5),
    recurrence,
    weekPattern: row.week_pattern,
    color: color as ColorKey,
    icon: icon as IconKey,
    cancelled: row.status === "cancelled",
    cancelledDates: exceptions.filter((exception) => exception.status === "cancelled").map((exception) => exception.occurrence_date),
    exceptions: eventExceptions,
  };
}

function calendarBlockFromRow(row: PlanningCalendarBlockRow): CalendarBlock {
  return { id: row.id, kind: row.kind, name: row.name ?? undefined, startsOn: row.starts_on, endsOn: row.ends_on };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function toDateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function addDays(date: Date, amount: number) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  result.setDate(result.getDate() + amount);
  return result;
}

function mondayOf(date: Date) {
  const weekday = date.getDay() || 7;
  return addDays(date, 1 - weekday);
}

function isoWeekday(date: Date) {
  return date.getDay() || 7;
}

function dayDifference(first: Date, second: Date) {
  const firstUtc = Date.UTC(first.getFullYear(), first.getMonth(), first.getDate());
  const secondUtc = Date.UTC(second.getFullYear(), second.getMonth(), second.getDate());
  return Math.round((secondUtc - firstUtc) / 86400000);
}

function getSchoolWeek(date: Date, year: SchoolYear) {
  if (!year.startsOn) return null;
  const anchor = mondayOf(parseDateKey(year.startsOn));
  const index = Math.floor(dayDifference(anchor, mondayOf(date)) / 7);
  const number = index + 1;
  const parity = number % 2 === 0 ? "even" : "odd";
  return { number, parity };
}

function getWeekDates(date: Date) {
  const monday = mondayOf(date);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

function getMonthDates(date: Date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1, 12);
  const gridStart = mondayOf(first);
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

function minutesSinceMidnight(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatDate(date: Date, locale: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function calendarBlockLabel(block: CalendarBlock, t: (key: never, values?: Record<string, string | number>) => string) {
  return block.name?.trim() || t(block.kind === "break" ? "planning.breaks" as never : "planning.holidays" as never);
}

function occurrencesForDates(events: ScheduleEvent[], dates: Date[], year: SchoolYear): Occurrence[] {
  if (!year.startsOn || !year.endsOn) return [];
  const dateKeys = new Set(dates.map(toDateKey));
  const result: Occurrence[] = [];
  for (const event of events) {
    const sourceDateKeys = new Set(dateKeys);
    for (const [sourceDate, exception] of Object.entries(event.exceptions)) {
      if (exception.overrideDate && dateKeys.has(exception.overrideDate)) sourceDateKeys.add(sourceDate);
    }
    for (const occurrenceDate of sourceDateKeys) {
      if (occurrenceDate < event.startsOn || (event.endsOn !== null && occurrenceDate > event.endsOn)) continue;
      if (event.recurrence === "once" && occurrenceDate !== event.date) continue;
      const sourceDate = parseDateKey(occurrenceDate);
      if (event.recurrence !== "once" && isoWeekday(sourceDate) !== event.dayOfWeek) continue;
      const week = getSchoolWeek(sourceDate, year);
      if (event.recurrence === "even" && week?.parity !== "even") continue;
      if (event.recurrence === "odd" && week?.parity !== "odd") continue;
      const exception = event.exceptions[occurrenceDate];
      const date = exception?.overrideDate ?? occurrenceDate;
      if (!dateKeys.has(date) || date < year.startsOn || date > year.endsOn) continue;
      if (year.blocks.some((block) => date >= block.startsOn && date <= block.endsOn)) continue;
      result.push({
        event,
        occurrenceDate,
        date,
        title: exception?.title ?? event.title,
        teacher: exception?.teacher ?? event.teacher,
        room: exception?.room ?? event.room,
        startTime: exception?.startTime ?? event.startTime,
        endTime: exception?.endTime ?? event.endTime,
        color: exception?.color ?? event.color,
        icon: exception?.icon ?? event.icon,
        cancelled: event.cancelled || exception?.exceptionStatus === "cancelled",
      });
    }
  }
  return result.sort((first, second) => first.startTime.localeCompare(second.startTime));
}

type PositionedOccurrence = Occurrence & { lane: number; lanes: number };
function layoutOverlaps(occurrences: Occurrence[]): PositionedOccurrence[] {
  const sorted = [...occurrences].sort((first, second) => minutesSinceMidnight(first.startTime) - minutesSinceMidnight(second.startTime) || minutesSinceMidnight(first.endTime) - minutesSinceMidnight(second.endTime));
  const positioned: PositionedOccurrence[] = [];
  let group: Occurrence[] = [];
  let groupEnd = -1;
  const flush = () => {
    if (!group.length) return;
    const laneEnds: number[] = [];
    const groupItems: Array<{ occurrence: Occurrence; lane: number }> = [];
    for (const occurrence of group) {
      const start = minutesSinceMidnight(occurrence.startTime);
      const end = minutesSinceMidnight(occurrence.endTime);
      let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = end;
      groupItems.push({ occurrence, lane });
    }
    groupItems.forEach(({ occurrence, lane }) => positioned.push({ ...occurrence, lane, lanes: laneEnds.length }));
    group = [];
    groupEnd = -1;
  };
  for (const occurrence of sorted) {
    const start = minutesSinceMidnight(occurrence.startTime);
    const end = minutesSinceMidnight(occurrence.endTime);
    if (group.length && start >= groupEnd) flush();
    group.push(occurrence);
    groupEnd = Math.max(groupEnd, end);
  }
  flush();
  return positioned;
}

function isCurrentOccurrence(occurrence: Occurrence, today: Date, now: Date) {
  if (occurrence.cancelled || occurrence.date !== toDateKey(today)) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return current >= minutesSinceMidnight(occurrence.startTime) && current < minutesSinceMidnight(occurrence.endTime);
}

function PlanningEventCard({ occurrence, courseName, current, compact, onClick, t }: {
  occurrence: PositionedOccurrence;
  courseName: string;
  current: boolean;
  compact?: boolean;
  onClick: () => void;
  t: (key: never, values?: Record<string, string | number>) => string;
}) {
  const { language } = useI18n();
  const locale = language === "zh" ? "zh-CN" : language;
  const Icon = subjectIconOptions.find((option) => option.name === occurrence.icon)?.Icon ?? subjectIconOptions[0].Icon;
  const start = minutesSinceMidnight(occurrence.startTime);
  const end = minutesSinceMidnight(occurrence.endTime);
  const top = (start - GRID_START_HOUR * 60) * HOUR_HEIGHT / 60;
  const height = Math.max((end - start) * HOUR_HEIGHT / 60, 34);
  const occurrenceDate = formatDate(parseDateKey(occurrence.date), locale, { weekday: "long", day: "numeric", month: "long" });
  const laneGap = 4;
  const style = {
    top: `${top}px`,
    height: `${height}px`,
    left: `calc(${(occurrence.lane * 100) / occurrence.lanes}% + ${laneGap / 2}px)`,
    width: `calc(${100 / occurrence.lanes}% - ${laneGap}px)`,
    "--event-fill": `color-mix(in srgb, ${occurrence.color} 15%, var(--surface))`,
    "--event-ink": "var(--text)",
    "--event-line": occurrence.color,
  } as React.CSSProperties;
  const accessibleDetails = [courseName, occurrenceDate, occurrence.teacher, occurrence.room && `${t("planning.roomPrefix" as never)} ${occurrence.room}`, `${occurrence.startTime}–${occurrence.endTime}`, occurrence.cancelled ? t("planning.cancelled" as never) : ""].filter(Boolean).join(", ");
  return (
    <button type="button" className={`planning-event ${occurrence.cancelled ? "is-cancelled" : ""} ${current ? "is-current" : ""} ${height < 47 ? "is-compact" : ""}`} style={style} onClick={onClick} aria-label={accessibleDetails}>
      <span className="planning-event-title"><Icon size={14} aria-hidden="true" /><strong>{courseName}</strong></span>
      {height >= 44 && <span className="planning-event-date">{occurrenceDate}</span>}
      {!occurrence.cancelled && height >= 58 && occurrence.teacher && <span className="planning-event-meta">{occurrence.teacher}</span>}
      {!occurrence.cancelled && height >= 70 && occurrence.room && <span className="planning-event-meta">{t("planning.roomPrefix" as never)} {occurrence.room}</span>}
      <span className="planning-event-time">{occurrence.startTime}–{occurrence.endTime}</span>
      {occurrence.cancelled && <span className="planning-event-status"><Ban size={12} /> {t("planning.cancelled" as never)}</span>}
      {current && <span className="planning-event-current">● {t("planning.inProgress" as never)}</span>}
    </button>
  );
}

function PlanningEventForm({ initial, mode, initialDate, schoolYear, subjects, onGoToCourses, onClose, onSave, t }: {
  initial?: EventFormValues;
  mode: "create" | "edit";
  initialDate: Date;
  schoolYear: SchoolYear;
  subjects: Subject[];
  onGoToCourses: () => void;
  onClose: () => void;
  onSave: (value: EventFormValues) => Promise<void>;
  t: (key: never, values?: Record<string, string | number>) => string;
}) {
  const { language } = useI18n();
  const locale = language === "zh" ? "zh-CN" : language;
  const initialValues: EventFormValues = initial ?? {
    title: "", subjectId: null, date: null, teacher: "", room: "", dayOfWeek: isoWeekday(initialDate), startTime: "09:00", endTime: "10:00", recurrence: "weekly", weekPattern: "all", color: defaultSubjectColor, icon: "book",
  };
  const [values, setValues] = useState(initialValues);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const eventColor = values.color;
  const eventIcon = values.icon;
  const set = <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) => setValues((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || values.endTime <= values.startTime) return;
    const singleDate = toDateKey(initialDate);
    setSaving(true);
    setSaveError("");
    try {
      await onSave({ ...values, title: values.title.trim(), teacher: values.teacher.trim(), room: values.room.trim(), color: eventColor, icon: eventIcon, date: values.recurrence === "once" ? singleDate : null });
    } catch {
      setSaveError(t("planning.saveError" as never));
    } finally {
      setSaving(false);
    }
  };
  const onSubjectChange = (rawId: string) => {
    const selectedSubject = subjects.find((subject) => subject.id === Number(rawId));
    setValues((current) => ({
      ...current,
      subjectId: selectedSubject?.id ?? null,
      ...(selectedSubject ? {
        title: selectedSubject.name,
        color: (subjectColors.find((color) => color.value.toLowerCase() === selectedSubject.color?.toLowerCase())?.value ?? current.color) as ColorKey,
        icon: (subjectIconOptions.find((option) => option.name === normalizeSubjectIcon(selectedSubject.icon))?.name ?? current.icon) as IconKey,
      } : {}),
    }));
  };
  const PreviewIcon = subjectIconOptions.find((option) => option.name === eventIcon)?.Icon ?? subjectIconOptions[0].Icon;
  return (
    <form className="planning-modal-form" onSubmit={submit}>
      <label className="planning-field planning-field-wide"><span>{t("planning.courseName" as never)}</span><input required value={values.title} onChange={(event) => set("title", event.target.value)} placeholder={t("planning.courseNamePlaceholder" as never)} /></label>
      <label className="planning-field planning-field-wide"><span>{t("planning.subject" as never)}</span><select value={values.subjectId ?? ""} onChange={(event) => onSubjectChange(event.target.value)}><option value="">{t("planning.chooseSubject" as never)}</option>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select>{!subjects.length && <span className="planning-course-unavailable">{t("planning.noSubjectsAvailable" as never)} <button type="button" className="text-button" onClick={onGoToCourses}>{t("planning.goToCourses" as never)}</button></span>}</label>
      <label className="planning-field"><span>{t("planning.teacher" as never)}</span><input value={values.teacher} onChange={(event) => set("teacher", event.target.value)} placeholder={t("planning.optional" as never)} /></label>
      <label className="planning-field"><span>{t("planning.room" as never)}</span><input value={values.room} onChange={(event) => set("room", event.target.value)} placeholder={t("planning.optional" as never)} /></label>
      <label className="planning-field"><span>{t("planning.day" as never)}</span><select value={values.dayOfWeek} onChange={(event) => set("dayOfWeek", Number(event.target.value))}>{DAY_NAMES.map((name, index) => <option key={name} value={index + 1}>{t(name as never)}</option>)}</select></label>
      <label className="planning-field"><span>{t("planning.week" as never)}</span><select value={values.recurrence === "once" ? "once" : values.recurrence === "weekly" ? "weekly" : values.recurrence} onChange={(event) => { const value = event.target.value as Recurrence; setValues((current) => ({ ...current, recurrence: value, weekPattern: value === "even" || value === "odd" ? value : "all" })); }}><option value="weekly">{t("planning.everyWeek" as never)}</option><option value="even">{t("planning.evenWeeks" as never)}</option><option value="odd">{t("planning.oddWeeks" as never)}</option><option value="once">{t("planning.once" as never)}</option></select></label>
      {values.recurrence === "once" && <p className="planning-single-date">{t("planning.singleDate" as never, { date: formatDate(initialDate, locale, { weekday: "long", day: "numeric", month: "long" }) })}</p>}
      <label className="planning-field"><span>{t("planning.startTime" as never)}</span><input type="time" required value={values.startTime} onChange={(event) => set("startTime", event.target.value)} /></label>
      <label className="planning-field"><span>{t("planning.endTime" as never)}</span><input type="time" required min={values.startTime} value={values.endTime} onChange={(event) => set("endTime", event.target.value)} /></label>
      <div className="planning-field planning-field-wide"><span>{t("planning.color" as never)}</span><div className="planning-swatches">{subjectColors.map((option) => <button type="button" key={option.value} className={`planning-swatch ${eventColor.toLowerCase() === option.value.toLowerCase() ? "selected" : ""}`} style={{ background: option.value }} onClick={() => set("color", option.value)} aria-label={option.name} aria-pressed={eventColor.toLowerCase() === option.value.toLowerCase()} title={option.name} />)}</div></div>
      <div className="planning-field planning-field-wide"><span>{t("planning.icon" as never)}</span><div className="planning-icon-picker">{subjectIconOptions.map(({ name, label, Icon }) => <button type="button" key={name} className={eventIcon === name ? "selected" : ""} onClick={() => set("icon", name)} aria-label={t(label as never)} aria-pressed={eventIcon === name}><Icon size={18} /></button>)}</div></div>
      <div className="planning-field planning-field-wide"><span>{t("planning.preview" as never)}</span><div className="planning-event planning-preview-event" style={{ "--event-fill": `color-mix(in srgb, ${eventColor} 15%, var(--surface))`, "--event-ink": "var(--text)", "--event-line": eventColor } as React.CSSProperties}><span className="planning-event-title"><PreviewIcon size={15} /><strong>{values.title || t("planning.courseNamePlaceholder" as never)}</strong></span>{(values.teacher || values.room) && <span className="planning-event-meta">{[values.teacher, values.room].filter(Boolean).join(" · ")}</span>}<span className="planning-event-time">{values.startTime}–{values.endTime}</span></div></div>
      {saveError && <p className="planning-validation-error" role="alert">{saveError}</p>}
      <div className="planning-form-actions"><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>{t("actions.cancel" as never)}</button><button type="submit" className="primary-button" disabled={saving}>{saving ? t("settings.saving" as never) : mode === "create" ? t("planning.addCourse" as never) : t("actions.save" as never)}</button></div>
    </form>
  );
}

function PlanningSettings({ value, onClose, onSave, t }: {
  value: SchoolYear;
  onClose: () => void;
  onSave: (value: SchoolYear, close: boolean, onProgress: (value: SchoolYear) => void) => Promise<void>;
  t: (key: never, values?: Record<string, string | number>) => string;
}) {
  const [draft, setDraft] = useState(value);
  const [invalidYear, setInvalidYear] = useState(false);
  const [blockErrors, setBlockErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const addBlock = (kind: CalendarBlock["kind"]) => setDraft((current) => ({ ...current, blocks: [...current.blocks, { id: createPlanningId(), kind, name: "", startsOn: "", endsOn: "" }] }));
  const updateBlock = (id: string | number, fields: Partial<CalendarBlock>) => {
    setDraft((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === id ? { ...block, ...fields } : block) }));
    setBlockErrors((current) => { const next = { ...current }; delete next[String(id)]; return next; });
  };
  const removeBlock = (id: string | number) => {
    setDraft((current) => ({ ...current, blocks: current.blocks.filter((block) => block.id !== id) }));
    setBlockErrors((current) => { const next = { ...current }; delete next[String(id)]; return next; });
  };
  const saveSettings = async () => {
    if (!draft.startsOn || !draft.endsOn || draft.endsOn < draft.startsOn) {
      setInvalidYear(true);
      return;
    }
    const errors: Record<string, string> = {};
    const validBlocks = draft.blocks.filter((block) => {
      if (!block.startsOn || !block.endsOn) {
        errors[String(block.id)] = t(block.kind === "break" ? "planning.breakDatesRequired" as never : "planning.holidayDateRequired" as never);
        return false;
      }
      if (block.endsOn < block.startsOn) {
        errors[String(block.id)] = t("planning.invalidBreakRange" as never);
        return false;
      }
      return true;
    }).map((block) => ({ ...block, name: block.name?.trim() || undefined }));
    setBlockErrors(errors);
    if (Object.keys(errors).length) return;
    setSaving(true);
    setSaveError("");
    try {
      await onSave({ ...draft, blocks: validBlocks }, true, setDraft);
    } catch {
      setSaveError(t("planning.saveError" as never));
    } finally {
      setSaving(false);
    }
  };
  return (
    <PlanningModal className="planning-settings-modal" title={t("planning.settingsTitle" as never)} description={t("planning.settingsDescription" as never)} onClose={onClose}>
        <div className="planning-settings-content">
          <section className="planning-settings-section"><h3>{t("planning.schoolYear" as never)}</h3><div className="planning-settings-grid"><label className="planning-field"><span>{t("planning.startDate" as never)}</span><input type="date" value={draft.startsOn} aria-invalid={invalidYear && !draft.startsOn} onChange={(event) => setDraft((current) => ({ ...current, startsOn: event.target.value }))} /></label><label className="planning-field"><span>{t("planning.endDate" as never)}</span><input type="date" value={draft.endsOn} min={draft.startsOn} aria-invalid={invalidYear && (!draft.endsOn || draft.endsOn < draft.startsOn)} onChange={(event) => setDraft((current) => ({ ...current, endsOn: event.target.value }))} /></label></div>{invalidYear && <p className="planning-validation-error">{t("planning.invalidSchoolYear" as never)}</p>}</section>
          <CalendarBlockList kind="break" blocks={draft.blocks.filter((block) => block.kind === "break")} errors={blockErrors} onAdd={() => addBlock("break")} onChange={updateBlock} onRemove={removeBlock} t={t} />
          <CalendarBlockList kind="holiday" blocks={draft.blocks.filter((block) => block.kind === "holiday")} errors={blockErrors} onAdd={() => addBlock("holiday")} onChange={updateBlock} onRemove={removeBlock} t={t} />
        </div>
        {saveError && <p className="planning-validation-error" role="alert">{saveError}</p>}
        <div className="planning-modal-footer"><button className="secondary-button" disabled={saving} onClick={onClose}>{t("actions.cancel" as never)}</button><button className="primary-button" disabled={saving} onClick={saveSettings}>{saving ? t("settings.saving" as never) : t("actions.save" as never)}</button></div>
    </PlanningModal>
  );
}

function CalendarBlockList({ kind, blocks, errors, onAdd, onChange, onRemove, t }: {
  kind: CalendarBlock["kind"];
  blocks: CalendarBlock[];
  errors: Record<string, string>;
  onAdd: () => void;
  onChange: (id: string | number, fields: Partial<CalendarBlock>) => void;
  onRemove: (id: string | number) => void;
  t: (key: never, values?: Record<string, string | number>) => string;
}) {
  const isBreak = kind === "break";
  return <section className="planning-settings-section"><div className="planning-settings-section-heading"><h3>{t(isBreak ? "planning.breaks" as never : "planning.holidays" as never)}</h3><span>{t("planning.configurable" as never)}</span></div>{blocks.length === 0 && <p className="planning-no-blocks">{t("planning.noCalendarBlocks" as never)}</p>}<div className="planning-calendar-block-list">{blocks.map((block) => <div className="planning-calendar-block-row" key={block.id}><div className={`planning-add-block ${isBreak ? "" : "planning-holiday-form"}`}><input aria-label={t(isBreak ? "planning.breakName" as never : "planning.holidayName" as never)} value={block.name ?? ""} onChange={(event) => onChange(block.id, { name: event.target.value })} placeholder={t(isBreak ? "planning.breakName" as never : "planning.holidayName" as never)} /><input aria-label={t(isBreak ? "planning.startDate" as never : "planning.date" as never)} type="date" value={block.startsOn} aria-invalid={Boolean(errors[block.id])} onChange={(event) => onChange(block.id, { startsOn: event.target.value, ...(!isBreak ? { endsOn: event.target.value } : {}) })} />{isBreak && <input aria-label={t("planning.endDate" as never)} type="date" value={block.endsOn} aria-invalid={Boolean(errors[block.id])} onChange={(event) => onChange(block.id, { endsOn: event.target.value })} />}<button type="button" className="icon-button" onClick={() => onRemove(block.id)} aria-label={`${t("actions.delete" as never)} ${block.name || t(isBreak ? "planning.breaks" as never : "planning.holidays" as never)}`} title={t("actions.delete" as never)}><X size={17} /></button></div>{errors[block.id] && <p className="planning-validation-error">{errors[block.id]}</p>}</div>)}</div><button type="button" className="planning-add-block-button" onClick={onAdd}><Plus size={15} />{t(isBreak ? "planning.addBreak" as never : "planning.addHoliday" as never)}</button></section>;
}

function ModalHeader({ title, description, onClose, id }: { title: string; description?: string; onClose: () => void; id: string }) {
  const { t } = useI18n();
  return <header className="planning-modal-header"><div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div><button type="button" className="planning-icon-button" onClick={onClose} aria-label={t("actions.close")}><X size={18} /></button></header>;
}

type PlanningPageProps = { subjects: Subject[]; onGoToCourses: () => void };

export default function PlanningPage({ subjects, onGoToCourses }: PlanningPageProps) {
  const { t, language } = useI18n();
  const { user } = useAuth();
  const [today, setToday] = useState(() => new Date());
  const [now, setNow] = useState(() => new Date());
  const [view, setView] = useState<ViewMode>(() => window.matchMedia("(max-width: 760px)").matches ? "day" : "week");
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [planningState, setPlanningState] = useState<PlanningState>(emptyPlanningState);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const schoolYear = planningState.schoolYear;
  const events = planningState.events;
  const setSchoolYear = (nextSchoolYear: SchoolYear) => setPlanningState((current) => ({ ...current, schoolYear: nextSchoolYear }));
  const setEvents = (update: ScheduleEvent[] | ((current: ScheduleEvent[]) => ScheduleEvent[])) => setPlanningState((current) => ({
    ...current,
    events: typeof update === "function" ? update(current.events) : update,
  }));
  const [modal, setModal] = useState<ModalState>(null);
  const [showBreaks, setShowBreaks] = useState(true);
  const [search, setSearch] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    setPlanningState(emptyPlanningState);
    if (!user) {
      setLoading(false);
      return () => { active = false; };
    }
    void (async () => {
      try {
        const years = await api.getPlanningYears();
        const todayKey = toDateKey(new Date());
        const selectedYear = years.find((year) => year.starts_on <= todayKey && year.ends_on >= todayKey) ?? years[0];
        if (!selectedYear) return;
        const [blocks, series] = await Promise.all([
          api.getPlanningCalendarBlocks(selectedYear.id),
          api.getPlanningSeries(selectedYear.id),
        ]);
        const exceptions = await api.getPlanningExceptions(series.map((item) => item.id));
        if (!active) return;
        const exceptionsBySeries = new Map<number, PlanningException[]>();
        for (const exception of exceptions) {
          const current = exceptionsBySeries.get(exception.series_id) ?? [];
          current.push(exception);
          exceptionsBySeries.set(exception.series_id, current);
        }
        setPlanningState({
          schoolYear: {
            id: selectedYear.id,
            name: selectedYear.name,
            startsOn: selectedYear.starts_on,
            endsOn: selectedYear.ends_on,
            timeZone: selectedYear.time_zone,
            blocks: blocks.map(calendarBlockFromRow),
          },
          events: series.map((row) => eventFromRow(row, exceptionsBySeries.get(row.id) ?? [])),
        });
      } catch (error) {
        console.error("[planning] load failed", error);
        if (active) setLoadError(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [user?.id, retryCount]);
  useEffect(() => {
    const timer = window.setInterval(() => { setToday(new Date()); setNow(new Date()); }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const locale = language === "zh" ? "zh-CN" : language;
  const yearIsConfigured = Boolean(schoolYear.startsOn && schoolYear.endsOn && schoolYear.endsOn >= schoolYear.startsOn);
  const dates = useMemo(() => view === "day" ? [selectedDate] : view === "week" ? getWeekDates(selectedDate) : getMonthDates(selectedDate), [selectedDate, view]);
  const occurrences = useMemo(() => occurrencesForDates(events, dates, schoolYear), [events, dates, schoolYear]);
  const week = getSchoolWeek(selectedDate, schoolYear);
  const rangeLabel = view === "day"
    ? formatDate(selectedDate, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : view === "month"
      ? formatDate(selectedDate, locale, { month: "long", year: "numeric" })
      : `${formatDate(dates[0], locale, { day: "numeric", month: "short" })} – ${formatDate(dates[6], locale, { day: "numeric", month: "short", year: "numeric" })}`;
  const occurrenceSubjectId = (occurrence: Occurrence) => {
    const exception = occurrence.event.exceptions[occurrence.occurrenceDate];
    const subjectId = exception?.subjectId !== undefined ? exception.subjectId : occurrence.event.subjectId;
    return subjectId !== null && subjects.some((subject) => subject.id === subjectId) ? subjectId : null;
  };
  const resolvedOccurrences = occurrences.map((occurrence) => {
    const subjectId = occurrenceSubjectId(occurrence);
    const linkedSubject = subjectId === null ? undefined : subjects.find((subject) => subject.id === subjectId);
    const linkedColor = subjectColors.find((color) => color.value.toLowerCase() === linkedSubject?.color?.toLowerCase())?.value;
    const linkedIcon = subjectIconOptions.find((option) => option.name === normalizeSubjectIcon(linkedSubject?.icon))?.name;
    return {
      ...occurrence,
      color: (linkedColor ?? occurrence.color) as ColorKey,
      icon: (linkedIcon ?? occurrence.icon) as IconKey,
    };
  });
  const resolveTitle = (occurrence: Occurrence) => {
    const subjectId = occurrenceSubjectId(occurrence);
    const subject = subjectId === null ? undefined : subjects.find((item) => item.id === subjectId);
    return subject ? `${subject.name} · ${occurrence.title}` : occurrence.title;
  };
  const filteredOccurrences = search.trim() ? resolvedOccurrences.filter((occurrence) => resolveTitle(occurrence).toLowerCase().includes(search.toLowerCase())) : resolvedOccurrences;
  const formatDayHeader = (date: Date) => formatDate(date, locale, { weekday: "short", day: "numeric" });
  const changePeriod = (direction: number) => {
    if (view === "day") setSelectedDate((date) => addDays(date, direction));
    else if (view === "week") setSelectedDate((date) => addDays(date, direction * 7));
    else setSelectedDate((date) => new Date(date.getFullYear(), date.getMonth() + direction, 15, 12));
  };
  const blocksOn = (date: Date) => schoolYear.blocks.filter((block) => (showBreaks || block.kind !== "break") && toDateKey(date) >= block.startsOn && toDateKey(date) <= block.endsOn);
  const saveNewEvent = async (values: EventFormValues) => {
    if (schoolYear.id === null) throw new Error("Année scolaire absente.");
    setSaveError(false);
    try {
      const recurrence = values.recurrence === "once" ? "once" : "weekly";
      const row = await api.createPlanningSeries({
        year_id: schoolYear.id,
        entry_type: "class",
        title: values.title,
        subject_id: values.subjectId,
        teacher: values.teacher || null,
        room: values.room || null,
        day_of_week: values.dayOfWeek,
        recurrence,
        week_pattern: recurrence === "once" ? "all" : values.weekPattern,
        starts_on: recurrence === "once" ? values.date ?? toDateKey(selectedDate) : schoolYear.startsOn,
        ends_on: recurrence === "once" ? null : schoolYear.endsOn,
        start_time: values.startTime,
        end_time: values.endTime,
        color_key: values.color,
        icon_key: values.icon,
        status: "active",
      });
      const savedEvent = eventFromRow(row, []);
      setEvents((current) => [savedEvent, ...current]);
      setModal(null);
    } catch (error) {
      setSaveError(true);
      throw error;
    }
  };
  const updateEvent = async (values: EventFormValues, occurrence: Occurrence, scope: "series" | "occurrence") => {
    setSaveError(false);
    try {
      if (scope === "series") {
        const recurrence = values.recurrence === "once" ? "once" : "weekly";
        const row = await api.updatePlanningSeries(occurrence.event.id, {
          year_id: schoolYear.id ?? occurrence.event.yearId,
          entry_type: "class",
          title: values.title,
          subject_id: values.subjectId,
          teacher: values.teacher || null,
          room: values.room || null,
          day_of_week: values.dayOfWeek,
          recurrence,
          week_pattern: recurrence === "once" ? "all" : values.weekPattern,
          starts_on: recurrence === "once" ? values.date ?? occurrence.date : schoolYear.startsOn,
          ends_on: recurrence === "once" ? null : schoolYear.endsOn,
          start_time: values.startTime,
          end_time: values.endTime,
          color_key: values.color,
          icon_key: values.icon,
          status: "active",
        });
        setEvents((current) => current.map((event) => event.id === row.id ? { ...eventFromRow(row, []), exceptions: event.exceptions, cancelledDates: event.cancelledDates } : event));
      } else {
        const previous = occurrence.event.exceptions[occurrence.occurrenceDate];
        const overrides = {
          title: values.title,
          subject_id: values.subjectId,
          teacher: values.teacher || null,
          room: values.room || null,
          start_time: values.startTime,
          end_time: values.endTime,
          color_key: values.color,
          icon_key: values.icon,
        };
        const row = await api.upsertPlanningException({
          series_id: occurrence.event.id,
          occurrence_date: occurrence.occurrenceDate,
          status: "modified",
          override_date: previous?.overrideDate ?? null,
          overrides,
        });
        setEvents((current) => current.map((event) => event.id === row.series_id ? { ...event, exceptions: { ...event.exceptions, [row.occurrence_date]: exceptionPatchFromRow(row) } } : event));
      }
      setModal(null);
    } catch (error) {
      setSaveError(true);
      throw error;
    }
  };
  const toggleOccurrenceCancelled = async (occurrence: Occurrence) => {
    setSaveError(false);
    try {
      const previous = occurrence.event.exceptions[occurrence.occurrenceDate];
      const restore = occurrence.cancelled && previous?.exceptionStatus === "cancelled";
      let savedPatch: EventPatch | null = null;
      if (restore && previous && Object.keys(eventPatchToOverrides(previous)).length) {
        const overrides = eventPatchToOverrides(previous);
        const row = await api.upsertPlanningException({ series_id: occurrence.event.id, occurrence_date: occurrence.occurrenceDate, status: "modified", override_date: previous.overrideDate ?? null, overrides });
        savedPatch = exceptionPatchFromRow(row);
      } else if (restore && previous?.exceptionId !== undefined) {
        await api.deletePlanningException(previous.exceptionId);
      } else {
        const row = await api.upsertPlanningException({
          series_id: occurrence.event.id,
          occurrence_date: occurrence.occurrenceDate,
          status: "cancelled",
          override_date: previous?.overrideDate ?? null,
          overrides: previous ? eventPatchToOverrides(previous) : {},
        });
        savedPatch = { exceptionId: row.id, exceptionStatus: row.status, overrideDate: row.override_date };
      }
      setEvents((current) => current.map((event) => {
        if (event.id !== occurrence.event.id) return event;
        const exceptions = { ...event.exceptions };
        if (savedPatch) exceptions[occurrence.occurrenceDate] = savedPatch;
        else delete exceptions[occurrence.occurrenceDate];
        return { ...event, exceptions, cancelledDates: Object.entries(exceptions).filter(([, patch]) => patch.exceptionStatus === "cancelled").map(([date]) => date) };
      }));
      setModal(null);
    } catch {
      setSaveError(true);
    }
  };
  const deleteEvent = async (occurrence: Occurrence) => {
    if (!window.confirm(t("planning.confirmDelete" as never))) return;
    setSaveError(false);
    try {
      await api.deletePlanningSeries(occurrence.event.id);
      setEvents((current) => current.filter((event) => event.id !== occurrence.event.id));
      setModal(null);
    } catch {
      setSaveError(true);
    }
  };
  const saveSettings = async (value: SchoolYear, _close: boolean, onProgress: (value: SchoolYear) => void) => {
    setSaveError(false);
    try {
      const yearFields = {
        name: value.name.trim() || "Année scolaire",
        starts_on: value.startsOn,
        ends_on: value.endsOn,
        time_zone: value.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      };
      const savedYear = value.id === null
        ? await api.createPlanningYear(yearFields)
        : await api.updatePlanningYear(value.id, yearFields);
      let workingValue: SchoolYear = { ...value, id: savedYear.id, name: savedYear.name, timeZone: savedYear.time_zone };
      onProgress(workingValue);
      const savedYearState = { ...workingValue };
      setPlanningState((current) => ({ ...current, schoolYear: { ...current.schoolYear, ...savedYearState, blocks: current.schoolYear.blocks } }));
      const pendingDeleteBlocks = schoolYear.blocks.filter((oldBlock) => !value.blocks.some((block) => block.id === oldBlock.id));

      for (const [index, block] of value.blocks.entries()) {
        const fields = {
          year_id: savedYear.id,
          kind: block.kind,
          name: block.name?.trim() || null,
          starts_on: block.startsOn,
          ends_on: block.kind === "holiday" ? block.startsOn : block.endsOn,
          description: null,
        } as const;
        const savedBlock = typeof block.id === "number"
          ? await api.updatePlanningCalendarBlock(block.id, fields)
          : await api.createPlanningCalendarBlock(fields);
        const nextBlocks = [...workingValue.blocks];
        nextBlocks[index] = calendarBlockFromRow(savedBlock);
        workingValue = { ...workingValue, blocks: nextBlocks };
        onProgress(workingValue);
        const progressValue = { ...workingValue, blocks: [...workingValue.blocks, ...pendingDeleteBlocks] };
        setPlanningState((current) => ({ ...current, schoolYear: progressValue }));
      }

      const retainedIds = new Set(workingValue.blocks.flatMap((block) => typeof block.id === "number" ? [block.id] : []));
      for (const block of schoolYear.blocks) {
        if (typeof block.id === "number" && !retainedIds.has(block.id)) {
          await api.deletePlanningCalendarBlock(block.id);
          setPlanningState((current) => ({ ...current, schoolYear: { ...current.schoolYear, blocks: current.schoolYear.blocks.filter((item) => item.id !== block.id) } }));
        }
      }
      setSchoolYear(workingValue);
      setModal(null);
    } catch (error) {
      setSaveError(true);
      throw error;
    }
  };
  const openCreate = () => setModal({ kind: "create" });
  const hourTicks = Array.from({ length: (GRID_END_HOUR - GRID_START_HOUR) * 2 + 1 }, (_, index) => GRID_START_HOUR * 60 + index * 30);
  const currentTimeTop = (now.getHours() * 60 + now.getMinutes() - GRID_START_HOUR * 60) * HOUR_HEIGHT / 60;

  if (loading) return <section className="planning-page" aria-live="polite">{t("planning.loading" as never)}</section>;
  if (loadError) return <section className="planning-page"><p className="planning-validation-error" role="alert">{t("planning.loadError" as never)}</p><button type="button" className="secondary-button" onClick={() => setRetryCount((count) => count + 1)}>{t("actions.retry" as never)}</button></section>;

  return (
    <section className="planning-page" aria-label={t("planning.title" as never)}>
      <header className="planning-toolbar">
        <div className="planning-brand-block">
          <div className="planning-title-line"><h1>{t("planning.title" as never)}</h1>{week ? <span className={`planning-parity-badge parity-${week.parity}`}><span />{t(week.parity === "even" ? "planning.weekEven" as never : "planning.weekOdd" as never, { number: week.number })}</span> : <span className="planning-parity-badge">{t("planning.yearNotConfigured" as never)}</span>}</div>
          <div className="planning-date-navigation"><button type="button" className="planning-icon-button" aria-label={t("planning.previous" as never)} title={t("planning.previous" as never)} onClick={() => changePeriod(-1)}><ChevronLeft size={18} /></button><button type="button" className="planning-today-button" onClick={() => setSelectedDate(new Date())}>{t("planning.today" as never)}</button><button type="button" className="planning-icon-button" aria-label={t("planning.next" as never)} title={t("planning.next" as never)} onClick={() => changePeriod(1)}><ChevronRight size={18} /></button><strong className="planning-range-label">{rangeLabel}</strong></div>
        </div>
        <div className="planning-toolbar-actions">
          <label className="planning-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("planning.search" as never)} aria-label={t("planning.search" as never)} />{search && <button type="button" onClick={() => setSearch("")} aria-label={t("actions.close" as never)}><X size={14} /></button>}</label>
          <div className="planning-view-switch" role="group" aria-label={t("planning.calendarView" as never)}>{(["day", "week", "month"] as ViewMode[]).map((mode) => <button type="button" key={mode} className={view === mode ? "active" : ""} aria-pressed={view === mode} onClick={() => setView(mode)}>{t(`planning.view.${mode}` as never)}</button>)}</div>
          <button type="button" className="planning-settings-button" onClick={() => setModal({ kind: "settings" })} aria-label={t("planning.settings" as never)} title={t("planning.settings" as never)}><Settings2 size={17} /><span>{t("planning.settings" as never)}</span></button>
          <button type="button" className="primary-button planning-add-button" onClick={openCreate}><Plus size={16} /> {t("planning.add" as never)}</button>
        </div>
      </header>
      {saveError && <p className="planning-validation-error" role="alert">{t("planning.saveError" as never)}</p>}
      {schoolYear.blocks.length > 0 && <div className="planning-calendar-notice"><CalendarDays size={15} /><span>{schoolYear.blocks.length} {t("planning.calendarBlocksConfigured" as never)}</span><button type="button" onClick={() => setShowBreaks((current) => !current)} aria-pressed={showBreaks}>{showBreaks ? t("planning.hideBreaks" as never) : t("planning.showBreaks" as never)}<ChevronDown size={14} /></button></div>}
      {!events.length && <p className="planning-empty-notice">{t("planning.emptyStatus" as never)}</p>}
      {view === "month" ? (
        <MonthView dates={dates} occurrences={filteredOccurrences} today={today} locale={locale} blocks={schoolYear.blocks} showBreaks={showBreaks} onSelectDate={(date) => { setSelectedDate(date); setView("day"); }} onSelectOccurrence={(occurrence) => setModal({ kind: "details", occurrence })} displayTitle={resolveTitle} t={t} />
      ) : (
        <TimeGrid dates={dates} occurrences={filteredOccurrences} today={today} now={now} locale={locale} hourTicks={hourTicks} currentTimeTop={currentTimeTop} view={view} schoolYear={schoolYear} blocksOn={blocksOn} formatDayHeader={formatDayHeader} onSelectOccurrence={(occurrence) => setModal({ kind: "details", occurrence })} displayTitle={resolveTitle} t={t} />
      )}
      {modal?.kind === "create" && <PlanningModal title={t(yearIsConfigured ? "planning.addCourse" as never : "planning.configureYear" as never)} description={t(yearIsConfigured ? "planning.createDescription" as never : "planning.configureYearDescription" as never)} onClose={() => setModal(null)}>{yearIsConfigured ? <PlanningEventForm mode="create" initialDate={selectedDate} schoolYear={schoolYear} subjects={subjects} onGoToCourses={() => { setModal(null); onGoToCourses(); }} onClose={() => setModal(null)} onSave={saveNewEvent} t={t} /> : <div className="planning-year-required"><p>{t("planning.configureYearHint" as never)}</p><button type="button" className="primary-button" onClick={() => setModal({ kind: "settings" })}><Settings2 size={16} />{t("planning.settings" as never)}</button></div>}</PlanningModal>}
      {modal?.kind === "details" && <EventDetails occurrence={modal.occurrence} title={resolveTitle(modal.occurrence)} error={saveError ? t("planning.actionError" as never) : ""} onClose={() => setModal(null)} onEdit={() => modal.occurrence.event.recurrence === "once" ? setModal({ kind: "edit", occurrence: modal.occurrence, scope: "series" }) : setModal({ kind: "edit-scope", occurrence: modal.occurrence })} onToggleCancelled={() => toggleOccurrenceCancelled(modal.occurrence)} onDelete={() => deleteEvent(modal.occurrence)} t={t} />}
      {modal?.kind === "edit-scope" && <PlanningModal title={t("planning.editScopeTitle" as never)} onClose={() => setModal(null)}><div className="planning-scope-options"><p>{t("planning.editScopeDescription" as never)}</p><button type="button" onClick={() => setModal({ kind: "edit", occurrence: modal.occurrence, scope: "occurrence" })}><CalendarDays size={18} /><span><strong>{t("planning.thisOccurrence" as never)}</strong><small>{modal.occurrence.date}</small></span><ChevronRight size={17} /></button><button type="button" onClick={() => setModal({ kind: "edit", occurrence: modal.occurrence, scope: "series" })}><CalendarDays size={18} /><span><strong>{t("planning.wholeSeries" as never)}</strong><small>{t("planning.seriesUpdateHint" as never)}</small></span><ChevronRight size={17} /></button><button type="button" disabled title={t("planning.futureUnavailable" as never)}><ArrowRight size={18} /><span><strong>{t("planning.thisAndFollowing" as never)}</strong><small>{t("planning.futureUnavailable" as never)}</small></span></button></div></PlanningModal>}
      {modal?.kind === "edit" && <PlanningModal title={modal.scope === "series" ? t("planning.editSeries" as never) : t("planning.editOccurrence" as never)} description={modal.scope === "occurrence" ? `${t("planning.occurrenceOf" as never)} ${modal.occurrence.date}` : undefined} onClose={() => setModal(null)}><PlanningEventForm mode="edit" initialDate={parseDateKey(modal.occurrence.date)} schoolYear={schoolYear} subjects={subjects} onGoToCourses={() => { setModal(null); onGoToCourses(); }} initial={{ title: modal.occurrence.title, subjectId: occurrenceSubjectId(modal.occurrence), date: modal.occurrence.date, teacher: modal.occurrence.teacher, room: modal.occurrence.room, dayOfWeek: modal.occurrence.event.dayOfWeek, startTime: modal.occurrence.startTime, endTime: modal.occurrence.endTime, recurrence: modal.occurrence.event.recurrence, weekPattern: modal.occurrence.event.weekPattern, color: modal.occurrence.color, icon: modal.occurrence.icon }} onClose={() => setModal(null)} onSave={(values) => updateEvent(values, modal.occurrence, modal.scope)} t={t} /></PlanningModal>}
      {modal?.kind === "settings" && <PlanningSettings value={schoolYear} onClose={() => setModal(null)} onSave={saveSettings} t={t} />}
    </section>
  );
}

function PlanningModal({ title, description, children, onClose, className = "" }: { title: string; description?: string; children: React.ReactNode; onClose: () => void; className?: string }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);
  return createPortal(<div className="modal-backdrop planning-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`modal planning-modal ${className}`} role="dialog" aria-modal="true" aria-labelledby="planning-modal-title"><ModalHeader title={title} description={description} onClose={onClose} id="planning-modal-title" />{children}</section></div>, document.body);
}

function EventDetails({ occurrence, title, error, onClose, onEdit, onToggleCancelled, onDelete, t }: { occurrence: Occurrence; title: string; error: string; onClose: () => void; onEdit: () => void; onToggleCancelled: () => void; onDelete: () => void; t: (key: never, values?: Record<string, string | number>) => string }) {
  const { language } = useI18n();
  const Icon = subjectIconOptions.find((option) => option.name === occurrence.icon)?.Icon ?? subjectIconOptions[0].Icon;
  const locale = language === "zh" ? "zh-CN" : language;
  return <PlanningModal title={title} description={formatDate(parseDateKey(occurrence.date), locale, { weekday: "long", day: "numeric", month: "long" })} onClose={onClose}><div className="planning-event-details"><div className="planning-detail-color" style={{ color: occurrence.color }}><Icon size={22} /></div><div className="planning-detail-time"><Clock3 size={16} />{occurrence.startTime} – {occurrence.endTime}</div>{occurrence.teacher && <div className="planning-detail-meta"><UserRound size={16} />{occurrence.teacher}</div>}{occurrence.room && <div className="planning-detail-meta"><MapPin size={16} />{occurrence.room}</div>}{occurrence.cancelled && <div className="planning-cancelled-banner"><Ban size={16} />{t("planning.cancelled" as never)}</div>}</div>{error && <p className="planning-validation-error" role="alert">{error}</p>}<div className="planning-detail-actions"><button type="button" className="secondary-button" onClick={onEdit}><Pencil size={15} />{t("actions.edit" as never)}</button><button type="button" className="secondary-button" onClick={onToggleCancelled}>{occurrence.cancelled ? <Check size={15} /> : <Ban size={15} />}{occurrence.cancelled ? t("planning.restore" as never) : t("planning.cancelOccurrence" as never)}</button><button type="button" className="planning-delete-button" onClick={onDelete}><Trash2 size={15} />{t("actions.delete" as never)}</button></div></PlanningModal>;
}

function TimeGrid({ dates, occurrences, today, now, locale, hourTicks, currentTimeTop, view, schoolYear, blocksOn, formatDayHeader, onSelectOccurrence, displayTitle, t }: {
  dates: Date[]; occurrences: Occurrence[]; today: Date; now: Date; locale: string; hourTicks: number[]; currentTimeTop: number; view: ViewMode; schoolYear: SchoolYear; blocksOn: (date: Date) => CalendarBlock[]; formatDayHeader: (date: Date) => string; onSelectOccurrence: (occurrence: Occurrence) => void; displayTitle: (occurrence: Occurrence) => string; t: (key: never, values?: Record<string, string | number>) => string;
}) {
  return <div className={`planning-calendar-shell ${view === "day" ? "is-day-view" : "is-week-view"}`}><div className="planning-grid-scroll"><div className="planning-time-grid" style={{ "--day-count": dates.length, "--grid-height": `${(GRID_END_HOUR - GRID_START_HOUR) * HOUR_HEIGHT}px` } as React.CSSProperties}>
    <div className="planning-grid-head"><div className="planning-head-time">{t("planning.time" as never)}</div>{dates.map((date) => { const current = toDateKey(date) === toDateKey(today); return <button type="button" key={toDateKey(date)} className={`planning-day-head ${current ? "is-today" : ""}`} onClick={() => { if (view === "week") return; }}><span>{formatDayHeader(date)}</span>{current && <i>{t("planning.today" as never)}</i>}{blocksOn(date).map((block) => <small key={block.id} className={`planning-block-label ${block.kind}`}>{block.name}</small>)}</button>; })}</div>
    <div className="planning-grid-body"><div className="planning-time-axis">{hourTicks.map((minutes) => <span key={minutes} style={{ top: `${(minutes - GRID_START_HOUR * 60) * HOUR_HEIGHT / 60}px` }}>{minutes % 60 === 0 ? `${pad(Math.floor(minutes / 60))}:00` : ""}</span>)}</div>{dates.map((date) => {
      const key = toDateKey(date);
      const dayOccurrences = layoutOverlaps(occurrences.filter((occurrence) => occurrence.date === key));
      const currentDay = key === toDateKey(today);
      const dayBlocks = blocksOn(date);
      return <div className={`planning-day-column ${currentDay ? "is-today" : ""}`} key={key} style={{ height: `${(GRID_END_HOUR - GRID_START_HOUR) * HOUR_HEIGHT}px` }}>
        {hourTicks.map((minutes) => <div className={`planning-time-line ${minutes % 60 === 0 ? "hour" : "half-hour"}`} key={minutes} style={{ top: `${(minutes - GRID_START_HOUR * 60) * HOUR_HEIGHT / 60}px` }} />)}
        {dayBlocks.map((block) => <div key={block.id} className={`planning-day-block ${block.kind}`} title={calendarBlockLabel(block, t)}><span>{calendarBlockLabel(block, t)}</span></div>)}
        {dayOccurrences.map((occurrence) => { const linkedName = displayTitle(occurrence); return <PlanningEventCard key={`${occurrence.event.id}:${occurrence.date}`} occurrence={occurrence} courseName={linkedName} current={isCurrentOccurrence(occurrence, today, now)} onClick={() => onSelectOccurrence(occurrence)} t={t} />; })}
        {currentDay && currentTimeTop >= 0 && currentTimeTop < (GRID_END_HOUR - GRID_START_HOUR) * HOUR_HEIGHT && <div className="planning-current-time" style={{ top: `${currentTimeTop}px` }}><i /> <span>{`${pad(now.getHours())}:${pad(now.getMinutes())}`}</span></div>}
      </div>;
    })}</div>
  </div></div><div className="planning-grid-caption"><span><i className="planning-caption-current" />{t("planning.currentTime" as never)}</span></div></div>;
}

function MonthView({ dates, occurrences, today, locale, blocks, showBreaks, onSelectDate, onSelectOccurrence, displayTitle, t }: {
  dates: Date[]; occurrences: Occurrence[]; today: Date; locale: string; blocks: CalendarBlock[]; showBreaks: boolean; onSelectDate: (date: Date) => void; onSelectOccurrence: (occurrence: Occurrence) => void; displayTitle: (occurrence: Occurrence) => string; t: (key: never, values?: Record<string, string | number>) => string;
}) {
  const dayLabels = DAY_NAMES.map((key) => t(key as never));
  return <div className="planning-month-view"><div className="planning-month-grid">{dayLabels.map((day) => <div className="planning-month-weekday" key={day}>{day.slice(0, 3)}</div>)}{dates.map((date) => {
    const key = toDateKey(date);
    const dayEvents = occurrences.filter((occurrence) => occurrence.date === key).sort((first, second) => first.startTime.localeCompare(second.startTime));
    const dayBlocks = blocks.filter((block) => (showBreaks || block.kind !== "break") && key >= block.startsOn && key <= block.endsOn);
    const inMonth = date.getMonth() === dates[14].getMonth();
    const current = key === toDateKey(today);
    return <div className={`planning-month-cell ${inMonth ? "" : "outside-month"} ${current ? "is-today" : ""}`} key={key}><button type="button" className="planning-month-date" onClick={() => onSelectDate(date)} aria-label={`${t("planning.openDay" as never)} ${formatDate(date, locale, { day: "numeric", month: "long" })}`}><span>{date.getDate()}</span>{current && <i />}</button>{dayBlocks.slice(0, 1).map((block) => <span className={`planning-month-block ${block.kind}`} key={block.id}>{calendarBlockLabel(block, t)}</span>)}<div className="planning-month-events">{dayEvents.slice(0, 3).map((occurrence) => <button type="button" className={`planning-month-event ${occurrence.cancelled ? "is-cancelled" : ""}`} style={{ "--event-line": occurrence.color } as React.CSSProperties} key={`${occurrence.event.id}:${key}`} onClick={() => onSelectOccurrence(occurrence)}><i />{displayTitle(occurrence)}</button>)}{dayEvents.length > 3 && <button type="button" className="planning-month-more" onClick={() => onSelectDate(date)}>{t("planning.more" as never, { count: dayEvents.length - 3 })}</button>}</div></div>;
  })}</div></div>;
}

