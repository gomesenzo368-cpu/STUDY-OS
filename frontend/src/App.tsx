import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  CalendarDays,
  ChevronRight,
  CircleHelp,
  FileText,
  Folder,
  LayoutDashboard,
  LibraryBig,
  ListTree,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Sun,
  Target,
  Trash2,
  TrendingUp,
  X,
  BrainCircuit,
  Bell,
  ArrowUpDown,
  GripVertical,
  MoveRight,
  Upload,
} from "lucide-react";
import { api } from "./api";
import RichTextEditor from "./components/RichTextEditor";
import SubjectEditor from "./components/SubjectEditor";
import DOMPurify from "dompurify";
import type {
  Chapter,
  Course,
  CourseFolder,
  Entity,
  Subject,
} from "./types";
import { useAuth } from "./contexts/AuthContext";
import AuthPage from "./pages/AuthPage";
import SettingsPage from "./pages/SettingsPage";
import SubjectIcon from "./components/SubjectIcon";
import { useI18n } from "./i18n/i18n";

type Page = "home" | "courses" | "settings" | "placeholder";
type ThemeMode = "light" | "dark" | "system";
type ModalState = {
  entity: Entity;
  item?: Subject | Chapter | CourseFolder | Course;
  parentId?: number;
  folderId?: number | null;
} | null;
type OrganizationEntry = {
  key: string;
  kind: "subject" | "chapter" | "folder" | "course";
  id: number;
  label: string;
  secondary?: string;
};
type OrganizationScope =
  | { kind: "subjects" }
  | { kind: "chapters"; subjectId: number }
  | { kind: "chapter-items"; chapterId: number };

const navItems = [
  { id: "home", label: "sidebar.home", icon: LayoutDashboard },
  { id: "courses", label: "sidebar.courses", icon: BookOpen },
  { id: "revisions", label: "sidebar.revisions", icon: BrainCircuit },
  { id: "controls", label: "sidebar.controls", icon: Target },
  { id: "planning", label: "sidebar.planning", icon: CalendarDays },
  { id: "progress", label: "sidebar.progress", icon: TrendingUp },
  { id: "assistant", label: "sidebar.assistant", icon: CircleHelp },
  { id: "settings", label: "sidebar.settings", icon: Settings },
] as const;

function organizationEntries(
  scope: OrganizationScope,
  subjects: Subject[],
  chapters: Chapter[],
  folders: CourseFolder[],
  courses: Course[],
  localItemOrder?: string[],
): OrganizationEntry[] {
  if (scope.kind === "subjects") {
    return subjects.map((subject) => ({ key: `subject:${subject.id}`, kind: "subject", id: subject.id, label: subject.name }));
  }
  if (scope.kind === "chapters") {
    return chapters.filter((chapter) => chapter.subject_id === scope.subjectId).map((chapter) => ({ key: `chapter:${chapter.id}`, kind: "chapter", id: chapter.id, label: chapter.name }));
  }
  const entries = [
    ...folders.filter((folder) => folder.chapter_id === scope.chapterId).map((folder) => ({ key: `folder:${folder.id}`, kind: "folder" as const, id: folder.id, label: folder.name, secondary: "Dossier de cours" })),
    ...courses.filter((course) => course.chapter_id === scope.chapterId).map((course) => ({ key: `course:${course.id}`, kind: "course" as const, id: course.id, label: course.title, secondary: "Cours" })),
  ];
  const order = new Map((localItemOrder ?? []).map((key, index) => [key, index]));
  return entries.sort((first, second) => (order.get(first.key) ?? Number.MAX_SAFE_INTEGER) - (order.get(second.key) ?? Number.MAX_SAFE_INTEGER));
}

function App() {
  const {
    user,
    profile,
    loading: authLoading,
    error: authError,
    signOut,
  } = useAuth();
  const { t } = useI18n();
  const [page, setPage] = useState<Page>("home");
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [courseFolders, setCourseFolders] = useState<CourseFolder[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    () =>
      (localStorage.getItem("study-os-theme-mode") as ThemeMode | null) ??
      (localStorage.getItem("study-os-theme") === "dark" ? "dark" : "light"),
  );
  const [search, setSearch] = useState("");
  const [selectedSubject, setSelectedSubject] = useState<number | null>(null);
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null);
  const [selectedCourseId, setSelectedCourseId] = useState<number | null>(null);
  const [organization, setOrganization] = useState<OrganizationScope | null>(null);
  const [organizationSaving, setOrganizationSaving] = useState(false);
  const [localChapterItemOrders, setLocalChapterItemOrders] = useState<Record<number, string[]>>({});
  const [modal, setModal] = useState<ModalState>(null);
  const [error, setError] = useState("");
  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.save"));
    }
  };

  const loadData = async () => {
    try {
      const nextSubjects = await api.subjects();
      setSubjects(nextSubjects);

      const [nextChapters, nextCourseFolders, nextCourses] = await Promise.all([
        api.getChapters(),
        api.courseFolders(),
        api.courses(),
      ]);
      setChapters(nextChapters);
      setCourseFolders(nextCourseFolders);
      setCourses(nextCourses);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.server"));
    }
  };
  useEffect(() => {
    if (user) void loadData();
  }, [user]);
  const dark =
    themeMode === "dark" ||
    (themeMode === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("study-os-theme-mode", themeMode);
    localStorage.setItem("study-os-theme", dark ? "dark" : "light");
  }, [dark, themeMode]);

  const filteredSubjects = useMemo(
    () =>
      subjects.filter((subject) =>
        subject.name.toLowerCase().includes(search.toLowerCase()),
      ),
    [subjects, search],
  );
  if (authLoading)
    return (
      <div className="auth-loading">
        <div>
          <strong>STUDY OS</strong>
          <span>{t("loading.space")}</span>
        </div>
      </div>
    );
  if (authError && !user)
    return (
      <main className="auth-loading">
        <div>
          <strong>{t('errors.server')}</strong>
          <span>{authError}</span>
          <button
            className="primary-button"
            onClick={() => window.location.reload()}
          >
            {t('actions.retry')}
          </button>
        </div>
      </main>
    );
  if (!user)
    return (
      <AuthPage
        dark={dark}
        onToggleTheme={() => setThemeMode(dark ? "light" : "dark")}
      />
    );

  const counts = {
    subjects: subjects.length,
    chapters: chapters.length,
    folders: courseFolders.length,
    courses: courses.length,
  };
  const selected = {
    subject: subjects.find((item) => item.id === selectedSubject),
    chapter: chapters.find((item) => item.id === selectedChapter),
    course: courses.find((item) => item.id === selectedCourseId),
  };

  const remove = async (entity: Entity, id: number, label: string) => {
    if (!window.confirm(t("confirm.delete", { name: label }))) return;
    try {
      if (entity === "subjects") {
        await api.deleteSubject(id);
        setSubjects((current) =>
          current.filter((subject) => subject.id !== id),
        );
        setModal((current) =>
          current?.entity === "subjects" && current.item?.id === id
            ? null
            : current,
        );
      } else if (entity === "chapters") {
        await api.deleteChapter(id);
        setChapters((current) =>
          current.filter((chapter) => chapter.id !== id),
        );
        setModal((current) =>
          current?.entity === "chapters" && current.item?.id === id
            ? null
            : current,
        );
      } else if (entity === "course_folders") {
        await api.deleteCourseFolder(id);
        setCourseFolders((current) => current.filter((folder) => folder.id !== id));
        setCourses((current) => current.map((course) => course.folder_id === id ? { ...course, folder_id: null } : course));
      } else {
        await api.deleteCourse(id);
        await loadData();
      }
      setSelectedSubject(null);
      setSelectedChapter(null);
      setSelectedCourseId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.delete'));
    }
  };

  const removeSubject = async (subject: Subject) => {
    try {
      await api.deleteSubject(subject.id);
      setSubjects((current) => current.filter((item) => item.id !== subject.id));
      const deletedChapterIds = new Set(
        chapters.filter((chapter) => chapter.subject_id === subject.id).map((chapter) => chapter.id),
      );
      const deletedFolderIds = new Set(
        courseFolders.filter((folder) => deletedChapterIds.has(folder.chapter_id)).map((folder) => folder.id),
      );
      setChapters((current) => current.filter((chapter) => !deletedChapterIds.has(chapter.id)));
      setCourseFolders((current) => current.filter((folder) => !deletedFolderIds.has(folder.id)));
      setCourses((current) => current.filter((course) => !deletedChapterIds.has(course.chapter_id)));
      setModal(null);
      setSelectedSubject(null);
      setSelectedChapter(null);
      setSelectedCourseId(null);
      setPage("home");
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.delete'));
    }
  };

  const beginOrganization = (scope: OrganizationScope) => {
    setOrganization(scope);
  };

  const finishOrganization = async (scope: OrganizationScope, entries: OrganizationEntry[]) => {
    if (scope.kind === "subjects") {
      const byId = new Map(subjects.map((subject) => [subject.id, subject]));
      setSubjects(entries.map((entry) => byId.get(entry.id)).filter((subject): subject is Subject => Boolean(subject)));
      setOrganization(null);
      return;
    }

    if (scope.kind === "chapters") {
      const orderedIds = entries.map((entry) => entry.id);
      const selectedIds = new Set(orderedIds);
      const ordered = entries.map((entry) => chapters.find((chapter) => chapter.id === entry.id)).filter((chapter): chapter is Chapter => Boolean(chapter));
      let cursor = 0;
      setChapters((current) => current.map((chapter) => chapter.subject_id === scope.subjectId && selectedIds.has(chapter.id) ? ordered[cursor++] : chapter));
      setOrganization(null);
      return;
    }

    const orderedKeys = entries.map((entry) => entry.key);
    const seen = new Set<string>();
    const hasDuplicate = orderedKeys.some((key) => {
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });

    if (hasDuplicate) {
      setError('La liste d’organisation contient des doublons.');
      return;
    }

    try {
      setError("");
      setOrganizationSaving(true);
      await api.reorderChapterItems(scope.chapterId, orderedKeys);
      setLocalChapterItemOrders((current) => ({ ...current, [scope.chapterId]: orderedKeys }));
      setOrganization(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'La sauvegarde de l’ordre a échoué.');
    } finally {
      setOrganizationSaving(false);
    }
  };

  const selectSubject = (id: number) => {
    setSelectedSubject(id > 0 ? id : null);
    setSelectedChapter(null);
    setPage("courses");
  };
  const selectChapter = (id: number) => setSelectedChapter(id);
  const openCourse = (course: Course) => {
    setSelectedCourseId(course.id);
    setPage("courses");
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <strong>STUDY OS</strong>
            <span>{t('brand.tagline')}</span>
          </div>
        </div>
        <nav className="main-nav">
          <p className="nav-label">{t('sidebar.workspace')}</p>
          {navItems.slice(0, 7).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-current={
                (id === "home" && page === "home") ||
                (id === "courses" && page === "courses")
                  ? "page"
                  : undefined
              }
              className={`nav-item ${(id === "home" && page === "home") || (id === "courses" && page === "courses") ? "active" : ""}`}
              onClick={() => {
                if (id === "home" || id === "courses") setPage(id);
                else setPage("placeholder");
              }}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{t(label)}</span>
              {id === "assistant" && <i className="beta">{t('sidebar.soon')}</i>}
            </button>
          ))}
        </nav>
        <nav className="sidebar-settings">
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => setPage("settings")}
          >
            <Settings size={18} strokeWidth={1.8} />
            <span>{t('sidebar.settings')}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="focus-card">
            <span className="focus-kicker">{t('sidebar.daily')}</span>
            <strong>
              {t('sidebar.step')}
            </strong>
            <div className="focus-line">
              <span />
              <span />
            </div>
            <small>{t('sidebar.streak')}</small>
          </div>
          <div className="user-chip">
            <div className="avatar">
              {(user.email?.[0] ?? "A").toUpperCase()}
            </div>
            <div>
             <strong>
  {user.user_metadata?.full_name ??
    user.email?.split("@")[0] ??
    t("settings.profile")}
</strong>
              <span>{user.email}</span>
            </div>
            <button
              className="profile-button"
              title={t('settings.profile')}
              aria-label={t('settings.profile')}
              onClick={() => setPage("settings")}
            >
              <MoreHorizontal size={18} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand">
            <div className="brand-mark">S</div>
            <strong>STUDY OS</strong>
          </div>
          <div className="topbar-title">
            {page === "home"
                ? t('sidebar.home')
              : page === "courses"
                ? t('sidebar.courses')
                : page === "settings"
                  ? t('sidebar.settings')
                  : t('sidebar.workspace')}
          </div>
          <div className="top-actions">
            <div className="search-box">
              <Search size={17} />
              <input
                aria-label={t('top.search')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('top.search')}
              />
              <kbd>⌘ K</kbd>
            </div>
            <button
              className="icon-button notification-button"
              aria-label={t('top.notifications')}
            >
              <Bell size={18} />
            </button>
            <button
              className="icon-button"
              aria-label={t('top.theme')}
              title={t('top.theme')}
              onClick={() => setThemeMode(dark ? "light" : "dark")}
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="top-avatar"
              aria-label={t('settings.profile')}
              title={t('settings.profile')}
              onClick={() => setPage("settings")}
            >
              {(user.email?.[0] ?? "A").toUpperCase()}
            </button>
          </div>
        </header>
        <div className="page-wrap">
          {error && (
            <div className="alert">
              <span>{error}</span>
              <button onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {organization ? (
            <OrganizationView
              scope={organization}
              items={organizationEntries(organization, subjects, chapters, courseFolders, courses, organization.kind === "chapter-items" ? localChapterItemOrders[organization.chapterId] : undefined)}
              isSaving={organizationSaving}
              onCancel={() => !organizationSaving && setOrganization(null)}
              onFinish={(items) => void finishOrganization(organization, items)}
            />
          ) : search.trim() ? (
            <SearchResults
              query={search}
              subjects={subjects}
              chapters={chapters}
              courses={courses}
              onOpen={openCourse}
            />
          ) : null}
          {!organization && !search.trim() && page === "home" && (
            <Dashboard
              displayName={
                profile?.display_name?.trim() ||
                user.user_metadata?.full_name?.trim() ||
                user.email?.split("@")[0] ||
                t('settings.profile')
              }
              counts={counts}
              subjects={subjects}
              chapters={chapters}
              courses={courses}
              onOpenSubject={selectSubject}
              onEditSubject={(subject) => setModal({ entity: "subjects", item: subject })}
              onOrganize={() => beginOrganization({ kind: "subjects" })}
              onOpenCourse={openCourse}
              onAdd={() => setModal({ entity: "subjects" })}
            />
          )}
          {!organization && !search.trim() &&
            page === "courses" &&
            (selected.course ? (
              <CourseDetail
                course={selected.course}
                subjects={subjects}
                chapters={chapters}
                onBack={() => setSelectedCourseId(null)}
                onEdit={(item) => setModal({ entity: "courses", item })}
                onDelete={remove}
                onMoved={async () => {
                  setSelectedCourseId(null);
                  await loadData();
                }}
              />
            ) : (
              <CoursesView
                subjects={subjects}
                chapters={chapters}
                courseFolders={courseFolders}
                courses={courses}
                selected={selected}
                selectedSubject={selectedSubject}
                selectedChapter={selectedChapter}
                onSubject={selectSubject}
                onChapter={selectChapter}
                onCourse={openCourse}
                onAdd={setModal}
                onEdit={(entity, item) => setModal({ entity, item })}
                onDelete={remove}
                onOrganizeSubjects={() => beginOrganization({ kind: "subjects" })}
                onOrganizeChapters={(subjectId) => beginOrganization({ kind: "chapters", subjectId })}
                onOrganizeItems={(chapterId) => beginOrganization({ kind: "chapter-items", chapterId })}
              />
            ))}
          {!organization && !search.trim() && page === "settings" && (
            <SettingsPage
              user={user}
              initialDark={dark}
              onThemeChange={setThemeMode}
              onSignOut={handleSignOut}
            />
          )}
          {!organization && !search.trim() && page === "placeholder" && <Placeholder />}
        </div>
      </main>
      <nav className="mobile-nav">
        {navItems.slice(0, 5).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={
              (id === "home" && page === "home") ||
              (id === "courses" && page === "courses")
                ? "active"
                : ""
            }
            onClick={() => {
              if (id === "home" || id === "courses") setPage(id);
              else setPage("placeholder");
            }}
          >
            <Icon size={19} />
            <span>{t(label)}</span>
          </button>
        ))}
        <button
          className={page === "settings" ? "active" : ""}
          onClick={() => setPage("settings")}
        >
          <Settings size={19} />
          <span>{t('sidebar.settings')}</span>
        </button>
      </nav>
      {modal &&
        (modal.entity === "subjects" ? (
          <SubjectEditor
            item={modal.item && "color" in modal.item ? modal.item : undefined}
            onClose={() => setModal(null)}
            onDelete={removeSubject}
            onSaved={async (savedSubject) => {
              setSubjects((current) => {
                const alreadyExists = current.some(
                  (subject) => subject.id === savedSubject.id,
                );
                const next = alreadyExists
                  ? current.map((subject) =>
                      subject.id === savedSubject.id ? savedSubject : subject,
                    )
                  : [...current, savedSubject];
                return next.sort((first, second) => first.created_at.localeCompare(second.created_at));
              });
              setModal(null);
            }}
            onError={setError}
          />
        ) : (
          <Editor
            modal={modal}
            subjects={subjects}
            chapters={chapters}
            courseFolders={courseFolders}
            onClose={() => setModal(null)}
            onSaved={async (savedItem) => {
              setModal(null);
              if (modal.entity === "chapters" && savedItem && "subject_id" in savedItem) {
                setChapters((current) => {
                  const alreadyExists = current.some(
                    (chapter) => chapter.id === savedItem.id,
                  );
                  const next = alreadyExists
                    ? current.map((chapter) =>
                        chapter.id === savedItem.id ? savedItem : chapter,
                      )
                    : [...current, savedItem];
                  return next.sort((first, second) => first.created_at.localeCompare(second.created_at));
                });
              } else if (modal.entity === "course_folders" && savedItem && "name" in savedItem && !("title" in savedItem)) {
                const savedFolder = savedItem as CourseFolder;
                setCourseFolders((current) => {
                  const next = current.some((folder) => folder.id === savedFolder.id)
                    ? current.map((folder) => folder.id === savedFolder.id ? savedFolder : folder)
                    : [...current, savedFolder];
                  return next.sort((first, second) => first.created_at.localeCompare(second.created_at));
                });
              } else if (modal.entity === "courses" && savedItem && "title" in savedItem) {
                setCourses((current) => {
                  const next = current.some((course) => course.id === savedItem.id)
                    ? current.map((course) => course.id === savedItem.id ? savedItem : course)
                    : [...current, savedItem];
                  return next.sort((first, second) => first.created_at.localeCompare(second.created_at));
                });
              } else {
                await loadData();
              }
            }}
            onError={setError}
          />
        ))}
    </div>
  );
}

function SearchResults({
  query,
  subjects,
  chapters,
  courses,
  onOpen,
}: {
  query: string;
  subjects: Subject[];
  chapters: Chapter[];
  courses: Course[];
  onOpen: (course: Course) => void;
}) {
  const { t } = useI18n();
  const needle = query.toLowerCase();
  const results = courses.filter((course) => {
    const chapter = chapters.find((item) => item.id === course.chapter_id);
    const subject = subjects.find((item) => item.id === chapter?.subject_id);
    return [
      course.title,
      course.content,
      chapter?.name,
      subject?.name,
    ].some((value) => value?.toLowerCase().includes(needle));
  });
  return (
    <section className="search-results">
      <div className="eyebrow">
        {t('search.label')} <span className="status-dot" /> {results.length} {t('search.results')}
      </div>
      <div className="welcome-row">
        <div>
          <h1>{t('search.results')}</h1>
          <p>{t('search.matches', { query })}</p>
        </div>
      </div>
      {results.length ? (
        <div className="course-list">
          {results.map((course) => {
            const chapter = chapters.find(
              (item) => item.id === course.chapter_id,
            );
            const subject = subjects.find(
              (item) => item.id === chapter?.subject_id,
            );
            return (
              <button
                className="search-result"
                key={course.id}
                onClick={() => onOpen(course)}
              >
                <div className="course-file">
                  <FileText size={20} />
                </div>
                <span>
                  <strong>{course.title}</strong>
                  <small>
                    {subject?.name} → {chapter?.name}
                  </small>
                  <em>
                    {course.content.replace(/<[^>]*>/g, "").slice(0, 180)}
                  </em>
                </span>
                <ChevronRight size={18} />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <strong>{t('search.none')}</strong>
          <br />
          {t('search.try')}
        </div>
      )}
    </section>
  );
}

function OrganizationView({
  scope,
  items,
  isSaving,
  onCancel,
  onFinish,
}: {
  scope: OrganizationScope;
  items: OrganizationEntry[];
  isSaving?: boolean;
  onCancel: () => void;
  onFinish: (items: OrganizationEntry[]) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(items);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const title = scope.kind === "subjects"
    ? t('home.subjects')
    : scope.kind === "chapters"
      ? t('library.chapters')
      : t('library.title');
  const iconFor = (kind: OrganizationEntry['kind']) => {
    if (kind === "folder") return <Folder size={18} />;
    if (kind === "course") return <FileText size={18} />;
    if (kind === "chapter") return <ListTree size={18} />;
    return <BookOpen size={18} />;
  };
  const moveEntry = (sourceKey: string, targetKey: string) => {
    if (sourceKey === targetKey) return;
    const sourceIndex = draft.findIndex((entry) => entry.key === sourceKey);
    const targetIndex = draft.findIndex((entry) => entry.key === targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...draft];
    const [entry] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, entry);
    setDraft(next);
  };
  return (
    <section className="organization-page">
      <div className="eyebrow"><span className="status-dot" /> {t('actions.organize').toUpperCase()}</div>
      <div className="organization-heading">
        <div><h1>{title}</h1><p>{t('organization.subtitle')}</p></div>
        <div className="organization-actions">
          <button className="secondary-button" onClick={onCancel} disabled={isSaving}>{t('actions.cancel')}</button>
          <button className="primary-button" onClick={() => onFinish(draft)} disabled={isSaving} aria-busy={isSaving}>{isSaving ? '...' : t('actions.finish')}</button>
        </div>
      </div>
      <div className="organization-list">
        {draft.length ? draft.map((entry) => (
          <div
            className={`organization-row ${draggedKey === entry.key ? "is-dragged" : ""}`}
            key={entry.key}
            draggable
            onDragStart={() => setDraggedKey(entry.key)}
            onDragEnd={() => setDraggedKey(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); if (draggedKey) moveEntry(draggedKey, entry.key); setDraggedKey(null); }}
          >
            <GripVertical className="drag-handle" size={18} />
            <span className="organization-icon">{iconFor(entry.kind)}</span>
            <span className="organization-copy"><strong>{entry.label}</strong>{entry.secondary && <small>{entry.secondary}</small>}</span>
          </div>
        )) : <div className="empty-state">{t('library.nothing')}</div>}
      </div>
    </section>
  );
}

function Dashboard({
  displayName,
  counts,
  subjects,
  chapters,
  courses,
  onOpenSubject,
  onEditSubject,
  onOrganize,
  onOpenCourse,
  onAdd,
}: {
  displayName: string;
  counts: Record<string, number>;
  subjects: Subject[];
  chapters: Chapter[];
  courses: Course[];
  onOpenSubject: (id: number) => void;
  onEditSubject: (subject: Subject) => void;
  onOrganize: () => void;
  onOpenCourse: (course: Course) => void;
  onAdd: () => void;
}) {
  const { t } = useI18n();
  const recentCourses = [...courses].sort((a, b) => b.id - a.id).slice(0, 3);
  return (
    <section className="dashboard">
      <div className="eyebrow">
        {t('home.eyebrow')} <span className="status-dot" /> {t('home.program')}
      </div>
      <div className="welcome-row">
        <div>
          <h1>
            {t('home.welcome', { name: displayName })} <span>✦</span>
          </h1>
          <p>{t('home.subtitle')}</p>
        </div>
        <div className="welcome-actions">
          <button className="secondary-button" onClick={onOrganize}><ArrowUpDown size={16} /> {t('actions.organize')}</button>
          <button className="primary-button" onClick={onAdd}><Plus size={17} /> {t('home.newSubject')}</button>
        </div>
      </div>
      <div className="stats-grid">
        {[
          [t('stats.subjects'), counts.subjects, t('stats.subjectsHint'), "subjects"],
          [t('stats.chapters'), counts.chapters, t('stats.chaptersHint'), "chapters"],
          [t('stats.courses'), counts.courses, t('stats.coursesHint'), "courses"],
        ].map(([label, value, hint, icon]) => (
          <div className="stat-card" key={label as string}>
            <div className="stat-icon">
              <StatIcon name={icon as string} />
            </div>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{hint}</small>
          </div>
        ))}
      </div>
      <div className="section-heading">
        <div>
          <span className="section-kicker">{t('home.program')}</span>
          <h2>{t('home.subjects')}</h2>
        </div>
        <button
          className="text-button"
          onClick={() => onOpenSubject(subjects[0]?.id)}
        >
          {t('home.viewAll')} <ChevronRight size={16} />
        </button>
      </div>
      <div className="subject-grid">
        {subjects.map((subject) => (
          <button
            className="subject-card"
            key={subject.id}
            onClick={() => onOpenSubject(subject.id)}
          >
            <div className="subject-top">
              <span
                className="subject-icon"
                style={{
                  backgroundColor: `${subject.color ?? "#1f7a8c"}18`,
                  color: subject.color ?? "#1f7a8c",
                }}
              >
                <SubjectIcon name={subject.icon} size={19} strokeWidth={1.8} />
              </span>
              <span
                className="subject-menu-button"
                role="button"
                tabIndex={0}
                aria-label={t('actions.editSubject')}
                onClick={(event) => {
                  event.stopPropagation();
                  onEditSubject(subject);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    onEditSubject(subject);
                  }
                }}
              >
                <MoreHorizontal size={17} />
              </span>
            </div>
            <h3>{subject.name}</h3>
            <p>{subject.description || t('home.subjectFallback')}</p>
            <div className="subject-meta">
              <span>
                <b>
                  {chapters.filter((item) => item.subject_id === subject.id).length}
                </b>{" "}
                chapitres
              </span>
              <span>
                <b>
                  {
                    courses.filter((course) =>
                      chapters.some(
                        (chapter) =>
                          chapter.id === course.chapter_id &&
                          chapter.subject_id === subject.id,
                      ),
                    ).length
                  }
                </b>{" "}
                cours
              </span>
            </div>
            <div className="progress-track">
              <span
                style={{
                  width: `${Math.min(100, 22 + ((subject.id * 13) % 65))}%`,
                  backgroundColor: subject.color ?? "#1f7a8c",
                }}
              />
            </div>
          </button>
        ))}
        <button className="add-card" onClick={onAdd}>
          <span>
            <Plus size={20} />
          </span>
          <strong>{t('home.addSubject')}</strong>
          <small>{t('home.buildSpace')}</small>
        </button>
      </div>
      <div className="section-heading recent-heading">
        <div>
          <span className="section-kicker">{t('home.activity')}</span>
          <h2>{t('home.recent')}</h2>
        </div>
      </div>
      <div className="recent-courses">
        {recentCourses.length ? (
          recentCourses.map((course) => (
            <button
              className="recent-course"
              key={course.id}
              onClick={() => onOpenCourse(course)}
            >
              <FileText size={18} />
              <span>
                <strong>{course.title}</strong>
                <small>{course.source_type === "demo" ? t('source.demo') : t('source.manual')}</small>
              </span>
              <ChevronRight size={16} />
            </button>
          ))
        ) : (
          <div className="empty-state">{t('home.noCourses')}</div>
        )}
      </div>
    </section>
  );
}

function StatIcon({ name }: { name: string }) {
  const icons = { subjects: LibraryBig, chapters: ListTree, courses: BookOpen };
  const Icon = icons[name as keyof typeof icons] ?? BookOpen;
  return <Icon size={20} strokeWidth={1.8} />;
}

function CoursesView({
  subjects,
  chapters,
  courseFolders,
  courses,
  selected,
  selectedSubject,
  selectedChapter,
  onSubject,
  onChapter,
  onCourse,
  onAdd,
  onEdit,
  onDelete,
  onOrganizeSubjects,
  onOrganizeChapters,
  onOrganizeItems,
}: {
  subjects: Subject[];
  chapters: Chapter[];
  courseFolders: CourseFolder[];
  courses: Course[];
  selected: { subject?: Subject; chapter?: Chapter };
  selectedSubject: number | null;
  selectedChapter: number | null;
  onSubject: (id: number) => void;
  onChapter: (id: number) => void;
  onCourse: (course: Course) => void;
  onAdd: (modal: ModalState) => void;
  onEdit: (entity: Entity, item: Subject | Chapter | CourseFolder | Course) => void;
  onDelete: (entity: Entity, id: number, label: string) => void;
  onOrganizeSubjects: () => void;
  onOrganizeChapters: (subjectId: number) => void;
  onOrganizeItems: (chapterId: number) => void;
}) {
  const { t } = useI18n();
  const visibleChapters = chapters.filter(
    (chapter) => chapter.subject_id === selectedSubject,
  );
  const visibleCourses = courses.filter(
    (course) => course.chapter_id === selectedChapter,
  );
  return (
    <section className="courses-page">
      <div className="eyebrow">
        {t('library.eyebrow')} <span className="status-dot" /> {t('home.program')}
      </div>
      <div className="welcome-row">
        <div>
          <h1>{t('library.title')}</h1>
          <p>{t('library.subtitle')}</p>
        </div>
        <div className="welcome-actions">
          <button className="secondary-button" onClick={() => selectedChapter ? onOrganizeItems(selectedChapter) : selectedSubject ? onOrganizeChapters(selectedSubject) : onOrganizeSubjects()}><ArrowUpDown size={16} /> {t('actions.organize')}</button>
          <button className="primary-button" onClick={() => onAdd({ entity: "subjects" })}><Plus size={17} /> {t('library.add')}</button>
        </div>
      </div>
      <div className="breadcrumbs">
        <button
          onClick={() => {
            onSubject(-1);
          }}
        >
          {t('library.title')}
        </button>
        {selected.subject && (
          <>
            <ChevronRight size={15} />
            <button onClick={() => onSubject(selected.subject!.id)}>
              {selected.subject.name}
            </button>
          </>
        )}
        {selected.chapter && (
          <>
            <ChevronRight size={15} />
            <span>{selected.chapter.name}</span>
          </>
        )}
      </div>
      {!selectedSubject ? (
        <EntityList
          title={t('library.subjects')}
          items={subjects}
          entity="subjects"
          icon="◉"
          onSelect={onSubject}
          onAdd={() => onAdd({ entity: "subjects" })}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ) : !selectedChapter ? (
        <EntityList
          title={t('library.chapters')}
          items={visibleChapters}
          entity="chapters"
          icon="▤"
          onSelect={onChapter}
          onAdd={() => onAdd({ entity: "chapters", parentId: selectedSubject })}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ) : selected.chapter ? (
        <CourseList
          courses={visibleCourses}
          folders={courseFolders.filter((folder) => folder.chapter_id === selectedChapter)}
          chapter={selected.chapter}
          onAdd={(folderId) => onAdd({ entity: "courses", parentId: selectedChapter, folderId })}
          onAddFolder={() => onAdd({ entity: "course_folders", parentId: selectedChapter })}
          onOrganize={() => onOrganizeItems(selectedChapter!)}
          onOpen={onCourse}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ) : null}
    </section>
  );
}

function EntityList({
  title,
  items,
  entity,
  icon,
  onSelect,
  onAdd,
  onEdit,
  onDelete,
}: {
  title: string;
  items: (Subject | Chapter)[];
  entity: Entity;
  icon: string;
  onSelect: (id: number) => void;
  onAdd: (folderId?: number) => void;
  onEdit: (entity: Entity, item: Subject | Chapter) => void;
  onDelete: (entity: Entity, id: number, label: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="library-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">{t('library.navigation')}</span>
          <h2>{title}</h2>
        </div>
        <button className="small-button" onClick={() => onAdd()}>
          <Plus size={15} /> {t('actions.add')}
        </button>
      </div>
      {items.length === 0 ? (
        <div className="empty-state">
          {t('library.nothing')} {t('library.firstItem')}
        </div>
      ) : (
        <div className="entity-list">
          {items.map((item) => (
            <div className="entity-row" key={item.id}>
              <button className="entity-main" onClick={() => onSelect(item.id)}>
                <span className="entity-icon">
                  {"icon" in item ? (
                    <SubjectIcon name={item.icon} size={17} strokeWidth={1.8} />
                  ) : (
                    icon
                  )}
                </span>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.description || t('editor.description')}</small>
                </span>
                <ChevronRight size={17} />
              </button>
              <div className="row-actions">
                <button title={t('actions.edit')} onClick={() => onEdit(entity, item)}>
                  <Pencil size={15} />
                </button>
                <button
                  title={t('actions.delete')}
                  onClick={() => onDelete(entity, item.id, item.name)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CourseList({
  courses,
  folders,
  chapter,
  onAdd,
  onAddFolder,
  onOrganize,
  onOpen,
  onEdit,
  onDelete,
}: {
  courses: Course[];
  folders: CourseFolder[];
  chapter: Chapter;
  onAdd: (folderId?: number) => void;
  onAddFolder: () => void;
  onOrganize: () => void;
  onOpen: (course: Course) => void;
  onEdit: (entity: Entity, item: Course | CourseFolder) => void;
  onDelete: (entity: Entity, id: number, label: string) => void;
}) {
  const { t } = useI18n();
  const [expandedFolders, setExpandedFolders] = useState<Set<number>>(() => new Set(folders.map((folder) => folder.id)));
  const orderedItems = [
    ...folders.map((item) => ({ type: "folder" as const, item })),
    ...courses.map((item) => ({ type: "course" as const, item })),
  ].sort((first, second) => first.item.created_at.localeCompare(second.item.created_at));
  const renderCourse = (course: Course) => (
    <article className="course-row" key={`course-${course.id}`}>
      <button className="course-open" onClick={() => onOpen(course)}>
        <div className="course-file"><FileText size={20} /></div>
        <div className="course-copy">
          <div><span className="course-label">{t('library.title')}</span><h3>{course.title}</h3></div>
          <p>{course.content.replace(/<[^>]*>/g, "").slice(0, 150) || t('library.nothing')}</p>
          <small>{t('course.source', { source: course.source_type === "demo" ? t('source.demo') : t('source.manual') })}</small>
        </div>
        <ChevronRight className="course-arrow" size={18} />
      </button>
      <div className="row-actions">
        <button title={t('actions.edit')} onClick={() => onEdit("courses", course)}><Pencil size={15} /></button>
        <button title={t('actions.delete')} onClick={() => onDelete("courses", course.id, course.title)}><Trash2 size={15} /></button>
      </div>
    </article>
  );
  const renderFolder = (folder: CourseFolder) => {
    const folderCourses = courses.filter((course) => course.folder_id === folder.id);
    return <div className="chapter-item-group" key={`folder-${folder.id}`}>
      <article className="course-row folder-row">
        <button className="course-open" aria-expanded={expandedFolders.has(folder.id)} onClick={() => setExpandedFolders((current) => { const next = new Set(current); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; })}>
          <div className="course-file"><Folder size={20} /></div>
          <div className="course-copy"><div><span className="course-label">{t('library.newFolder')}</span><h3>{folder.name}</h3></div><small>{folderCourses.length} {t('library.coursesInFolder')}</small></div>
          <ChevronRight className="course-arrow" size={18} />
        </button>
        <div className="row-actions">
          <button title={t('actions.edit')} onClick={() => onEdit('course_folders', folder)}><Pencil size={15} /></button>
          <button title={t('actions.delete')} onClick={() => onDelete('course_folders', folder.id, folder.name)}><Trash2 size={15} /></button>
        </div>
      </article>
    </div>;
  };
  return (
    <div className="library-panel">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">{t('library.chapter')}</span>
          <h2>{chapter.name}</h2>
        </div>
        <button className="small-button" onClick={() => onAdd()}>
          <Plus size={15} /> {t('library.newCourse')}
        </button>
        <button className="small-button" onClick={onAddFolder}>
          <Plus size={15} /> {t('library.newFolder')}
        </button>
        <button className="small-button" onClick={onOrganize}>
          <ArrowUpDown size={15} /> {t('actions.organize')}
        </button>
      </div>
      {orderedItems.length === 0 ? (
        <div className="empty-state">
          <strong>{t('library.noCourses')}</strong>
          <br />
          {t('library.firstCourse')}
        </div>
      ) : (
        <div className="course-list">
          {orderedItems.map((entry) => entry.type === "folder" ? renderFolder(entry.item) : renderCourse(entry.item))}
        </div>
      )}
    </div>
  );
}

function CourseDetail({
  course,
  subjects,
  chapters,
  onBack,
  onEdit,
  onDelete,
  onMoved,
}: {
  course: Course;
  subjects: Subject[];
  chapters: Chapter[];
  onBack: () => void;
  onEdit: (course: Course) => void;
  onDelete: (entity: Entity, id: number, label: string) => void;
  onMoved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const chapter = chapters.find((item) => item.id === course.chapter_id);
  const subject = subjects.find((item) => item.id === chapter?.subject_id);
  const [moveChapter, setMoveChapter] = useState(course.chapter_id);
  const [moving, setMoving] = useState(false);
  const move = async () => {
    if (moveChapter === course.chapter_id) return;
    setMoving(true);
    try {
      await api.updateCourse(course, {
        chapter_id: moveChapter,
        title: course.title,
        content: course.content,
        original_content: course.original_content,
        source_type: course.source_type,
        folder_id: course.folder_id,
      });
      await onMoved();
    } finally {
      setMoving(false);
    }
  };
  return (
    <section className="course-detail">
      <button className="back-button" onClick={onBack}>
        <ArrowLeft size={17} /> {t('library.back')}
      </button>
      <div className="breadcrumbs">
        <span>{t('library.title')}</span>
        <ChevronRight size={15} />
        <span>{subject?.name}</span>
        <ChevronRight size={15} />
        <span>{chapter?.name}</span>
      </div>
      <div className="detail-header">
        <div>
          <span className="course-label">COURS · {course.source_type}</span>
          <h1>{course.title}</h1>
          <p>
            {subject?.name} · {chapter?.name}
          </p>
        </div>
      </div>
      <div className="detail-actions">
        <button className="primary-button" onClick={() => onEdit(course)}>
          <Pencil size={16} /> {t('actions.edit')}
        </button>
        <button
          className="secondary-button"
          onClick={move}
          disabled={moving || moveChapter === course.chapter_id}
        >
          <MoveRight size={16} /> {moving ? t('actions.moving') : t('actions.move')}
        </button>
        <button
          className="danger-button"
          onClick={() => onDelete("courses", course.id, course.title)}
        >
          <Trash2 size={16} /> {t('actions.delete')}
        </button>
      </div>
      <div className="move-panel">
        <label>
          {t('actions.move')}
          <select
            value={moveChapter}
            onChange={(event) => setMoveChapter(Number(event.target.value))}
          >
            {chapters.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <span>{t('course.moveInfo')}</span>
      </div>
      <article
        className="course-content"
        dangerouslySetInnerHTML={{
          __html: DOMPurify.sanitize(
            course.content || `<p>${t('library.nothing')}</p>`,
          ),
        }}
      />
      <div className="course-meta">
        <span>
          {t('course.created', { date: new Date(course.created_at).toLocaleDateString() })}
        </span>
        <span>
          {t('course.updated', { date: new Date(course.updated_at).toLocaleDateString() })}
        </span>
      </div>
    </section>
  );
}

function Placeholder() {
  const { t } = useI18n();
  return (
    <section className="placeholder">
      <span className="placeholder-icon">✦</span>
      <span className="section-kicker">{t('sidebar.soon')}</span>
      <h1>{t('sidebar.soon')}</h1>
      <p>{t('home.subtitle')}</p>
    </section>
  );
}

function Editor({
  modal,
  subjects,
  chapters,
  courseFolders,
  onClose,
  onSaved,
  onError,
}: {
  modal: NonNullable<ModalState>;
  subjects: Subject[];
  chapters: Chapter[];
  courseFolders: CourseFolder[];
  onClose: () => void;
  onSaved: (item?: Chapter | CourseFolder | Course) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const item = modal.item;
  const isEdit = Boolean(item);
  const entity = modal.entity;
  const [name, setName] = useState(
    item && "name" in item
      ? item.name
      : item && "title" in item
        ? item.title
        : "",
  );
  const [description, setDescription] = useState(
    item && "description" in item ? (item.description ?? "") : "",
  );
  const [content, setContent] = useState(
    item && "content" in item ? item.content : "",
  );
  const [parentId, setParentId] = useState(
    modal.parentId ??
      (item && "subject_id" in item
        ? item.subject_id
        : item && "chapter_id" in item
            ? item.chapter_id
            : subjects[0]?.id),
  );
  const [courseSubjectId, setCourseSubjectId] = useState(
    item && "chapter_id" in item
      ? chapters.find((chapter) => chapter.id === item.chapter_id)?.subject_id ??
        subjects[0]?.id ??
        0
      : (subjects[0]?.id ?? 0),
  );
  const [folderId, setFolderId] = useState<number | null>(
    modal.folderId ?? (item && "folder_id" in item ? item.folder_id : null),
  );
  const [importedFilename, setImportedFilename] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState(
    item && "source_type" in item ? item.source_type : "manual",
  );
  const courseChapters = chapters.filter(
    (chapter) => chapter.subject_id === courseSubjectId,
  );
  const title = isEdit ? t('actions.edit') : t('actions.add');
  const importFile = async (file: File) => {
    try {
      const imported = await api.importFile(file);
      setContent(imported.content);
      setImportedFilename(imported.filename);
      setSourceType(imported.source_type);
    } catch (err) {
      onError(err instanceof Error ? err.message : t('errors.import'));
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      if (entity === "chapters") {
        const fields = {
          subject_id: Number(parentId),
          name: name.trim(),
          description: description.trim() || null,
        };
        const savedChapter = isEdit
          ? await api.updateChapter(item as Chapter, fields)
          : await api.createChapter(fields);
        await onSaved(savedChapter);
      } else if (entity === "course_folders") {
        const fields = { chapter_id: Number(parentId), name: name.trim() };
        const savedFolder = isEdit
          ? await api.updateCourseFolder(item as CourseFolder, fields)
          : await api.createCourseFolder(fields);
        await onSaved(savedFolder);
      } else if (entity === "courses") {
          const fields = {
            chapter_id: Number(parentId),
            folder_id: folderId,
            title: name.trim(),
            content,
            original_content:
              isEdit && item && "original_content" in item
                ? item.original_content
                : content,
            source_type: sourceType,
          };
          const savedCourse = isEdit
            ? await api.updateCourse(item as Course, fields)
            : await api.createCourse(fields);
          await onSaved(savedCourse);
      }
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Enregistrement impossible.",
      );
    }
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form className="modal course-editor-modal" onSubmit={submit}>
        <div className="modal-head">
          <div>
            <span className="section-kicker">{t('editor.description')}</span>
            <h2>
              {title}{" "}
              {entity === "subjects"
                ? t('editor.labelName')
                : entity === "chapters" || entity === "course_folders"
                    ? t('editor.chapter')
                    : t('editor.labelTitle')}
            </h2>
          </div>
          <button type="button" className="close-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {entity === "courses" ? (
          <div className="dependent-fields">
            <label>
              {t('editor.subject')}
              <select
                value={courseSubjectId}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setCourseSubjectId(next);
                  setParentId(chapters.find((chapter) => chapter.subject_id === next)?.id ?? 0);
                  setFolderId(null);
                }}
              >
                {subjects.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('editor.chapter')}
              <select
                required
                value={parentId}
                onChange={(event) => setParentId(Number(event.target.value))}
              >
                {courseChapters.map((chapter) => (
                  <option key={chapter.id} value={chapter.id}>
                    {chapter.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('editor.folder')}
              <select
                value={folderId ?? ""}
                onChange={(event) => setFolderId(event.target.value ? Number(event.target.value) : null)}
              >
                <option value="">{t('editor.noFolder')}</option>
                {courseFolders.filter((folder) => folder.chapter_id === parentId).map((folder) => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          entity !== "subjects" && (
            <label>
              {t('editor.parent')}
              <select
                value={parentId}
                onChange={(event) => setParentId(Number(event.target.value))}
              >
                {(entity === "course_folders" ? chapters : subjects).map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {"name" in parent ? parent.name : ""}
                  </option>
                ))}
              </select>
            </label>
          )
        )}
        <label>
          {entity === "courses" ? t('editor.labelTitle') : t('editor.labelName')}
          <input
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('editor.coursePlaceholder')}
          />
        </label>
        <label>
          {t('editor.description')}
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('editor.descriptionPlaceholder')}
            rows={3}
          />
        </label>
        {entity === "courses" && (
          <>
            <label>
              {t('editor.content')}
              <RichTextEditor
                value={content}
                onChange={setContent}
                onImport={importFile}
              />
            </label>
            {importedFilename && (
              <div className="file-chip">
                <Upload size={14} /> {importedFilename}
              </div>
            )}
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            {t('actions.cancel')}
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={entity === "courses" && !parentId}
          >
            {isEdit ? t('actions.save') : t('actions.create')}
          </button>
        </div>
      </form>
    </div>
  );
}

export default App;
