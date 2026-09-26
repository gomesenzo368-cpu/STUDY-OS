import { useEffect, useMemo, useRef, useState } from "react";
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
  ClipboardCheck,
  Sparkles,
  Eye,
} from "lucide-react";
import { api, type CourseDocumentUploadProgress } from "./api";
import { createCourseWithDocuments, CourseDocumentWorkflowError, removeCancelledUpload } from "./courseDocumentWorkflow";
import RichTextEditor from "./components/RichTextEditor";
import CourseDocuments from "./components/CourseDocuments";
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
import {
  AssistantPage,
  ControlsPage,
  PlanningPage,
  ProgressPage,
  RevisionsPage,
  StudyCoursePage,
} from "./components/study/ModulePages";
import { useI18n } from "./i18n/i18n";

type Page = "home" | "courses" | "revisions" | "controls" | "planning" | "progress" | "assistant" | "study" | "settings" | "placeholder";
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
  createdAt: string;
  icon?: string | null;
  secondary?: string;
};
type OrganizationScope =
  | { kind: "subjects" }
  | { kind: "chapters"; subjectId: number }
  | { kind: "folder-courses"; folderId: number }
  | { kind: "chapter-items"; chapterId: number };

const navItems = [
  { id: "home", label: "sidebar.home", icon: LayoutDashboard },
  { id: "courses", label: "sidebar.courses", icon: BookOpen },
  { id: "revisions", label: "sidebar.revisions", icon: BrainCircuit },
  { id: "controls", label: "sidebar.controls", icon: ClipboardCheck },
  { id: "planning", label: "sidebar.planning", icon: CalendarDays },
  { id: "progress", label: "sidebar.progress", icon: TrendingUp },
  { id: "assistant", label: "sidebar.assistant", icon: Sparkles },
  { id: "settings", label: "sidebar.settings", icon: Settings },
] as const;

function comparePositionedItems(
  first: { position: number | null; created_at: string; id: number },
  second: { position: number | null; created_at: string; id: number },
) {
  if (first.position !== null && second.position !== null && first.position !== second.position) {
    return first.position - second.position;
  }
  if (first.position !== null && second.position === null) return -1;
  if (first.position === null && second.position !== null) return 1;
  const createdAtOrder = first.created_at.localeCompare(second.created_at);
  return createdAtOrder || first.id - second.id;
}

function compareFolderCourses(first: Course, second: Course) {
  if (first.folder_position !== null && second.folder_position !== null && first.folder_position !== second.folder_position) return first.folder_position - second.folder_position;
  if (first.folder_position !== null && second.folder_position === null) return -1;
  if (first.folder_position === null && second.folder_position !== null) return 1;
  return first.created_at.localeCompare(second.created_at) || first.id - second.id;
}

function organizationEntries(
  scope: OrganizationScope,
  subjects: Subject[],
  chapters: Chapter[],
  folders: CourseFolder[],
  courses: Course[],
  localItemOrder?: string[],
): OrganizationEntry[] {
  if (scope.kind === "subjects") {
    return [...subjects].sort(comparePositionedItems).map((subject) => ({ key: `subject:${subject.id}`, kind: "subject", id: subject.id, label: subject.name, createdAt: subject.created_at, icon: subject.icon }));
  }
  if (scope.kind === "chapters") {
    return chapters.filter((chapter) => chapter.subject_id === scope.subjectId).sort(comparePositionedItems).map((chapter) => ({ key: `chapter:${chapter.id}`, kind: "chapter", id: chapter.id, label: chapter.name, createdAt: chapter.created_at }));
  }
  if (scope.kind === "folder-courses") {
    return courses
      .filter((course) => course.folder_id === scope.folderId)
      .sort(compareFolderCourses)
      .map((course) => ({ key: `course:${course.id}`, kind: "course", id: course.id, label: course.title, createdAt: course.created_at, secondary: "Cours" }));
  }
  const entries = [
    ...folders.filter((folder) => folder.chapter_id === scope.chapterId).map((folder) => ({ key: `folder:${folder.id}`, kind: "folder" as const, id: folder.id, label: folder.name, createdAt: folder.created_at, secondary: "Dossier de cours" })),
    ...courses.filter((course) => course.chapter_id === scope.chapterId && course.folder_id === null).map((course) => ({ key: `course:${course.id}`, kind: "course" as const, id: course.id, label: course.title, createdAt: course.created_at, secondary: "Cours" })),
  ];
  const order = new Map((localItemOrder ?? []).map((key, index) => [key, index]));
  return entries.sort((first, second) => {
    const firstPosition = order.get(first.key) ?? Number.MAX_SAFE_INTEGER;
    const secondPosition = order.get(second.key) ?? Number.MAX_SAFE_INTEGER;
    if (firstPosition !== secondPosition) return firstPosition - secondPosition;
    return first.createdAt.localeCompare(second.createdAt);
  });
}

function chapterItemKey(item: { type: "course" | "folder"; id: number }) {
  return `${item.type}:${item.id}`;
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
  const [openFolderId, setOpenFolderId] = useState<number | null>(null);
  const [previewFolderId, setPreviewFolderId] = useState<number | null>(null);
  const [folderAddMenuId, setFolderAddMenuId] = useState<number | null>(null);
  const [organization, setOrganization] = useState<OrganizationScope | null>(null);
  const [organizationSaving, setOrganizationSaving] = useState(false);
  const [localChapterItemOrders, setLocalChapterItemOrders] = useState<Record<number, string[]>>({});
  const [modal, setModal] = useState<ModalState>(null);
  const [error, setError] = useState("");
  const loadChapterItemOrder = async (chapterId: number) => {
    try {
      const items = await api.chapterItems(chapterId);
      const order = items.map(chapterItemKey);
      setLocalChapterItemOrders((current) => {
        if (order.length === 0) {
          const next = { ...current };
          delete next[chapterId];
          return next;
        }
        return { ...current, [chapterId]: order };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.server"));
    }
  };
  const addChapterItem = async (
    chapterId: number,
    item: { type: "course" | "folder"; id: number },
    prepend: boolean,
  ) => {
    const items = await api.chapterItems(chapterId);
    const itemKey = chapterItemKey(item);
    const existingOrder = items.map(chapterItemKey);
    const alreadyExists = existingOrder.includes(itemKey);

    if (alreadyExists && !prepend) return existingOrder;

    if (!alreadyExists) {
      const position = items.reduce((maximum, current) => Math.max(maximum, current.position), -1) + 1;
      await api.createChapterItem({
        chapter_id: chapterId,
        course_id: item.type === "course" ? item.id : null,
        folder_id: item.type === "folder" ? item.id : null,
        position,
      });
    }

    const currentOrder = existingOrder.filter((key) => key !== itemKey);
    const nextOrder = prepend ? [itemKey, ...currentOrder] : [...currentOrder, itemKey];
    if (prepend) await api.reorderChapterItems(chapterId, nextOrder);
    return nextOrder;
  };
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
  useEffect(() => {
    if (previewFolderId === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewFolderId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewFolderId]);

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
      const removedCourse = entity === "courses" ? courses.find((course) => course.id === id) : undefined;
      const removedFolder = entity === "course_folders" ? courseFolders.find((folder) => folder.id === id) : undefined;
      if (entity === "subjects") {
        await api.deleteSubject(id);
        await loadData();
        if (selectedSubject === id) {
          setSelectedSubject(null);
          setSelectedChapter(null);
          setSelectedCourseId(null);
          setOpenFolderId(null);
          setPreviewFolderId(null);
          setFolderAddMenuId(null);
        }
        setModal((current) =>
          current?.entity === "subjects" && current.item?.id === id
            ? null
            : current,
        );
      } else if (entity === "chapters") {
        await api.deleteChapter(id);
        await loadData();
        if (selectedChapter === id) {
          setSelectedChapter(null);
          setSelectedCourseId(null);
          setOpenFolderId(null);
          setPreviewFolderId(null);
          setFolderAddMenuId(null);
        }
        setLocalChapterItemOrders((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        setModal((current) =>
          current?.entity === "chapters" && current.item?.id === id
            ? null
            : current,
        );
      } else if (entity === "course_folders") {
        await api.deleteCourseFolder(id);
        await loadData();
        if (openFolderId === id) setOpenFolderId(null);
        if (previewFolderId === id) setPreviewFolderId(null);
        if (folderAddMenuId === id) setFolderAddMenuId(null);
        if (removedFolder) await loadChapterItemOrder(removedFolder.chapter_id);
      } else {
        await api.deleteCourse(id);
        await loadData();
        if (selectedCourseId === id) setSelectedCourseId(null);
        const chapterId = removedCourse?.chapter_id ?? selectedChapter;
        if (chapterId !== null) await loadChapterItemOrder(chapterId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.delete'));
    }
  };

  const removeSubject = async (subject: Subject) => {
    try {
      const deletedChapterIds = new Set(
        chapters.filter((chapter) => chapter.subject_id === subject.id).map((chapter) => chapter.id),
      );
      const deletedFolderIds = new Set(
        courseFolders.filter((folder) => deletedChapterIds.has(folder.chapter_id)).map((folder) => folder.id),
      );
      await api.deleteSubject(subject.id);
      await loadData();
      setModal(null);
      if (selectedSubject === subject.id || (selectedChapter !== null && deletedChapterIds.has(selectedChapter))) {
        setSelectedSubject(null);
        setSelectedChapter(null);
        setSelectedCourseId(null);
        setOpenFolderId(null);
      }
      if (previewFolderId !== null && deletedFolderIds.has(previewFolderId)) setPreviewFolderId(null);
      if (openFolderId !== null && deletedFolderIds.has(openFolderId)) setOpenFolderId(null);
      if (folderAddMenuId !== null && deletedFolderIds.has(folderAddMenuId)) setFolderAddMenuId(null);
      setLocalChapterItemOrders((current) => {
        const next = { ...current };
        deletedChapterIds.forEach((chapterId) => delete next[chapterId]);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.delete'));
    }
  };

  const beginOrganization = (scope: OrganizationScope) => {
    setOrganization(scope);
  };

  const finishOrganization = async (scope: OrganizationScope, entries: OrganizationEntry[]) => {
    if (scope.kind === "subjects") {
      try {
        setError("");
        setOrganizationSaving(true);
        await api.reorderSubjects(entries.map((entry) => entry.id));
        const byId = new Map(subjects.map((subject) => [subject.id, subject]));
        setSubjects(entries.flatMap((entry, position) => {
          const subject = byId.get(entry.id);
          return subject ? [{ ...subject, position }] : [];
        }));
        setOrganization(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'La sauvegarde de l’ordre a échoué.');
      } finally {
        setOrganizationSaving(false);
      }
      return;
    }

    if (scope.kind === "chapters") {
      try {
        setError("");
        setOrganizationSaving(true);
        await api.reorderChapters(scope.subjectId, entries.map((entry) => entry.id));
        const positions = new Map(entries.map((entry, position) => [entry.id, position]));
        setChapters((current) => current.map((chapter) => {
          const position = positions.get(chapter.id);
          return chapter.subject_id === scope.subjectId && position !== undefined
            ? { ...chapter, position }
            : chapter;
        }));
        setOrganization(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'La sauvegarde de l’ordre a échoué.');
      } finally {
        setOrganizationSaving(false);
      }
      return;
    }

    if (scope.kind === "folder-courses") {
      try {
        setError("");
        setOrganizationSaving(true);
        await api.reorderFolderCourses(scope.folderId, entries.map((entry) => entry.id));
        const positions = new Map(entries.map((entry, position) => [entry.id, position]));
        setCourses((current) => current.map((course) => {
          const position = positions.get(course.id);
          return course.folder_id === scope.folderId && position !== undefined
            ? { ...course, folder_position: position }
            : course;
        }));
        setOrganization(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'La sauvegarde de l’ordre a échoué.');
      } finally {
        setOrganizationSaving(false);
      }
      return;
    }

    const visibleKeys = new Set(entries.map((entry) => entry.key));
    const currentChapterOrder = localChapterItemOrders[scope.chapterId] ?? [];
    let nextVisibleIndex = 0;
    const orderedKeys = currentChapterOrder.length
      ? [
          ...currentChapterOrder.map((key) => visibleKeys.has(key) ? entries[nextVisibleIndex++]!.key : key),
          ...entries.slice(nextVisibleIndex).map((entry) => entry.key),
        ]
      : entries.map((entry) => entry.key);
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
    setOpenFolderId(null);
    setPreviewFolderId(null);
    setFolderAddMenuId(null);
    setPage("courses");
  };
  const selectChapter = (id: number) => {
    setSelectedChapter(id);
    setOpenFolderId(null);
    setPreviewFolderId(null);
    setFolderAddMenuId(null);
    void loadChapterItemOrder(id);
  };
  const openCourse = (course: Course) => {
    setSelectedCourseId(course.id);
    setOpenFolderId((current) => current === course.folder_id ? current : null);
    setPreviewFolderId(null);
    setFolderAddMenuId(null);
    setPage("courses");
  };

  const attachCoursesToFolder = async (folder: CourseFolder, coursesToAttach: Course[]) => {
    await Promise.all(coursesToAttach.map((course) => api.appendCourseToFolder(course, folder.id)));
    const attachedIds = new Set(coursesToAttach.map((course) => course.id));
    setCourses((current) => current.map((course) => attachedIds.has(course.id) ? { ...course, folder_id: folder.id } : course));
    setFolderAddMenuId(null);
  };

  const resetCourseContext = () => {
    setSelectedSubject(null);
    setSelectedChapter(null);
    setSelectedCourseId(null);
    setOpenFolderId(null);
    setPreviewFolderId(null);
    setFolderAddMenuId(null);
    setOrganization(null);
    setOrganizationSaving(false);
    setModal(null);
  };

  const isCourseContext = (value: Page) => value === "courses" || value === "study";
  const navigateToPage = (nextPage: Page) => {
    if (isCourseContext(page) !== isCourseContext(nextPage)) {
      resetCourseContext();
    }
    setPage(nextPage);
  };
  const navigateFromPrimaryNavigation = (nextPage: Page) => {
    if (nextPage === "courses") {
      resetCourseContext();
      setPage("courses");
      return;
    }
    navigateToPage(nextPage);
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
                page === id
                  ? "page"
                  : undefined
              }
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => {
                navigateFromPrimaryNavigation(id);
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
            onClick={() => navigateToPage("settings")}
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
              onClick={() => navigateToPage("settings")}
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
              : page === "revisions"
                ? t('sidebar.revisions')
              : page === "controls"
                ? t('sidebar.controls')
              : page === "planning"
                ? t('sidebar.planning')
              : page === "progress"
                ? t('sidebar.progress')
              : page === "assistant"
                ? t('sidebar.assistant')
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
              onClick={() => navigateToPage("settings")}
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
          ) : page === "study" && selected.course ? (
            <StudyCoursePage
              course={selected.course}
              subject={selected.subject}
              chapter={selected.chapter}
              onBack={() => setPage("courses")}
            />
          ) : !search.trim() && page === "revisions" ? (
            <RevisionsPage
              subjects={subjects}
              chapters={chapters}
              courses={courses}
            />
          ) : !search.trim() && page === "controls" ? (
            <ControlsPage />
          ) : !search.trim() && page === "planning" ? (
            <PlanningPage subjects={subjects} onGoToCourses={() => navigateFromPrimaryNavigation("courses")} />
          ) : !search.trim() && page === "progress" ? (
            <ProgressPage />
          ) : !search.trim() && page === "assistant" ? (
            <AssistantPage />
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
                onStudy={() => setPage("study")}
                onEdit={(item) => setModal({ entity: "courses", item })}
                onDelete={remove}
                onMoved={async () => {
                  setSelectedCourseId(null);
                  await loadData();
                }}
              />
            ) : openFolderId !== null && selectedChapter ? (
              <FolderDetail
                folder={courseFolders.find((folder) => folder.id === openFolderId)}
                chapter={selected.chapter}
                subject={selected.subject}
                courses={courses}
                onBack={() => setOpenFolderId(null)}
                onOpenCourse={openCourse}
                onAddCourse={() => setFolderAddMenuId(openFolderId)}
                onOrganize={() => setOrganization({ kind: "folder-courses", folderId: openFolderId })}
                onEdit={(entity, item) => setModal({ entity, item })}
                onDelete={remove}
              />
            ) : (
              <CoursesView
                subjects={subjects}
                chapters={chapters}
                courseFolders={courseFolders}
                courses={courses}
                chapterItemOrder={selectedChapter ? localChapterItemOrders[selectedChapter] : undefined}
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
                onOpenFolder={(folderId) => setOpenFolderId(folderId)}
                onPreviewFolder={(folderId) => setPreviewFolderId(folderId)}
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
        {navItems.slice(0, 7).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={
              page === id ? "active" : ""
            }
            onClick={() => {
              navigateFromPrimaryNavigation(id);
            }}
          >
            <Icon size={19} />
            <span>{t(label)}</span>
          </button>
        ))}
        <button
          className={page === "settings" ? "active" : ""}
          onClick={() => navigateToPage("settings")}
        >
          <Settings size={19} />
          <span>{t('sidebar.settings')}</span>
        </button>
      </nav>
      {previewFolderId !== null && (
        <FolderPreview
          folder={courseFolders.find((folder) => folder.id === previewFolderId)}
          courses={courses}
          onClose={() => setPreviewFolderId(null)}
          onOpenCourse={openCourse}
        />
      )}
      {folderAddMenuId !== null && (
        <FolderCourseAddModal
          folder={courseFolders.find((folder) => folder.id === folderAddMenuId)}
          courses={courses}
          onClose={() => setFolderAddMenuId(null)}
          onCreate={() => {
            const folder = courseFolders.find((item) => item.id === folderAddMenuId);
            if (!folder) return;
            setFolderAddMenuId(null);
            setModal({ entity: "courses", parentId: folder.chapter_id, folderId: folder.id });
          }}
          onAttach={attachCoursesToFolder}
          onError={setError}
        />
      )}
      {modal &&
        (modal.entity === "subjects" ? (
          <SubjectEditor
            item={modal.item && "color" in modal.item ? modal.item : undefined}
            onClose={() => setModal(null)}
            onDelete={removeSubject}
            onSaved={async (savedSubject) => {
              const alreadyExists = subjects.some((subject) => subject.id === savedSubject.id);
              if (!alreadyExists) {
                const orderedIds = [savedSubject.id, ...subjects.map((subject) => subject.id)];
                await api.reorderSubjects(orderedIds);
                const positions = new Map(orderedIds.map((id, position) => [id, position]));
                const byId = new Map(subjects.map((subject) => [subject.id, subject]));
                byId.set(savedSubject.id, savedSubject);
                setSubjects(orderedIds.flatMap((id) => {
                  const subject = byId.get(id);
                  const position = positions.get(id);
                  return subject && position !== undefined ? [{ ...subject, position }] : [];
                }));
              } else {
                setSubjects((current) => current.map((subject) => subject.id === savedSubject.id ? savedSubject : subject).sort(comparePositionedItems));
              }
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
                const chapter = savedItem as Chapter;
                const alreadyExists = chapters.some((item) => item.id === chapter.id);
                if (!alreadyExists) {
                  const siblingIds = chapters
                    .filter((item) => item.subject_id === chapter.subject_id)
                    .sort(comparePositionedItems)
                    .map((item) => item.id);
                  const orderedIds = [chapter.id, ...siblingIds];
                  await api.reorderChapters(chapter.subject_id, orderedIds);
                  const positions = new Map(orderedIds.map((id, position) => [id, position]));
                  setChapters((current) => {
                    const byId = new Map(current.map((item) => [item.id, item]));
                    byId.set(chapter.id, chapter);
                    return [...byId.values()].map((item) => {
                      const position = positions.get(item.id);
                      return position !== undefined ? { ...item, position } : item;
                    }).sort(comparePositionedItems);
                  });
                } else {
                  setChapters((current) => current.map((item) => item.id === chapter.id ? chapter : item).sort(comparePositionedItems));
                }
              } else if (modal.entity === "course_folders" && savedItem && "name" in savedItem && !("title" in savedItem)) {
                const savedFolder = savedItem as CourseFolder;
                const alreadyExists = courseFolders.some((folder) => folder.id === savedFolder.id);
                if (!alreadyExists) {
                  const chapterOrder = await addChapterItem(savedFolder.chapter_id, { type: "folder", id: savedFolder.id }, true);
                  setLocalChapterItemOrders((current) => ({ ...current, [savedFolder.chapter_id]: chapterOrder }));
                }
                setCourseFolders((current) => {
                  const next = current.some((folder) => folder.id === savedFolder.id)
                    ? current.map((folder) => folder.id === savedFolder.id ? savedFolder : folder)
                    : [...current, savedFolder];
                  return next.sort((first, second) => first.created_at.localeCompare(second.created_at));
                });
              } else if (modal.entity === "courses" && savedItem && "title" in savedItem) {
                const savedCourse = savedItem as Course;
                const alreadyExists = courses.some((course) => course.id === savedCourse.id);
                let folderPositions: Map<number, number> | undefined;
                if (!alreadyExists) {
                  const chapterOrder = await addChapterItem(
                    savedCourse.chapter_id,
                    { type: "course", id: savedCourse.id },
                    savedCourse.folder_id === null,
                  );
                  setLocalChapterItemOrders((current) => ({ ...current, [savedCourse.chapter_id]: chapterOrder }));
                  if (savedCourse.folder_id !== null) {
                    const orderedIds = [
                      savedCourse.id,
                      ...courses.filter((course) => course.folder_id === savedCourse.folder_id).map((course) => course.id),
                    ];
                    await api.reorderFolderCourses(savedCourse.folder_id, orderedIds);
                    folderPositions = new Map(orderedIds.map((id, position) => [id, position]));
                  }
                }
                const courseForState = folderPositions ? { ...savedCourse, folder_position: 0 } : savedCourse;
                setCourses((current) => {
                  const next = current.some((course) => course.id === courseForState.id)
                    ? current.map((course) => course.id === courseForState.id ? courseForState : course)
                    : [...current, courseForState];
                  return next.map((course) => {
                    const position = folderPositions?.get(course.id);
                    return position !== undefined ? { ...course, folder_position: position } : course;
                  }).sort((first, second) => first.created_at.localeCompare(second.created_at));
                });
              } else {
                await loadData();
              }
            }}
            onDocumentUploadComplete={(course) => {
              setPage("courses");
              setSelectedCourseId(course.id);
              setOpenFolderId(null);
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
  const iconFor = (entry: OrganizationEntry) => {
    if (entry.kind === "folder") return <Folder size={18} />;
    if (entry.kind === "course") return <FileText size={18} />;
    if (entry.kind === "chapter") return <ListTree size={18} />;
    return <SubjectIcon name={entry.icon} size={18} />;
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
            <span className="organization-icon">{iconFor(entry)}</span>
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
          <h1 className="display-title">
            {t('home.welcome', { name: displayName })} <span>✦</span>
          </h1>
          <p>{t('home.subtitle')}</p>
        </div>
        <div className="welcome-actions">
          <button className="small-button organize-button" onClick={onOrganize}><ArrowUpDown size={16} /> {t('actions.organize')}</button>
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
          <strong>{t('library.newSubject')}</strong>
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
  chapterItemOrder,
  selected,
  selectedSubject,
  selectedChapter,
  onSubject,
  onChapter,
  onCourse,
  onAdd,
  onEdit,
  onDelete,
  onOpenFolder,
  onPreviewFolder,
  onOrganizeSubjects,
  onOrganizeChapters,
  onOrganizeItems,
}: {
  subjects: Subject[];
  chapters: Chapter[];
  courseFolders: CourseFolder[];
  courses: Course[];
  chapterItemOrder?: string[];
  selected: { subject?: Subject; chapter?: Chapter };
  selectedSubject: number | null;
  selectedChapter: number | null;
  onSubject: (id: number) => void;
  onChapter: (id: number) => void;
  onCourse: (course: Course) => void;
  onAdd: (modal: ModalState) => void;
  onEdit: (entity: Entity, item: Subject | Chapter | CourseFolder | Course) => void;
  onDelete: (entity: Entity, id: number, label: string) => void;
  onOpenFolder: (folderId: number) => void;
  onPreviewFolder: (folderId: number) => void;
  onOrganizeSubjects: () => void;
  onOrganizeChapters: (subjectId: number) => void;
  onOrganizeItems: (chapterId: number) => void;
}) {
  const { t } = useI18n();
  const visibleChapters = chapters
    .filter((chapter) => chapter.subject_id === selectedSubject)
    .sort(comparePositionedItems);
  const chapterCourses = courses.filter(
    (course) => course.chapter_id === selectedChapter,
  );
  const visibleCourses = chapterCourses.filter((course) => course.folder_id === null);
  return (
    <section className="courses-page">
      <div className="eyebrow">
        {t('library.eyebrow')} <span className="status-dot" /> {t('home.program')}
      </div>
      <div className="welcome-row">
        <div>
          <h1 className="display-title">{t('library.title')}</h1>
          <p>{t('library.subtitle')}</p>
        </div>
        <div className="welcome-actions">
          <button className="small-button organize-button" onClick={() => selectedChapter ? onOrganizeItems(selectedChapter) : selectedSubject ? onOrganizeChapters(selectedSubject) : onOrganizeSubjects()}><ArrowUpDown size={16} /> {t('actions.organize')}</button>
          <button className="primary-button" onClick={() => onAdd({ entity: "subjects" })}><Plus size={17} /> {t('library.newSubject')}</button>
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
          allChapterCourses={chapterCourses}
          folders={courseFolders.filter((folder) => folder.chapter_id === selectedChapter)}
          itemOrder={chapterItemOrder}
          chapter={selected.chapter}
          onAdd={(folderId) => onAdd({ entity: "courses", parentId: selectedChapter, folderId })}
          onAddFolder={() => onAdd({ entity: "course_folders", parentId: selectedChapter })}
          onOrganize={() => onOrganizeItems(selectedChapter!)}
          onOpen={onCourse}
          onEdit={onEdit}
          onDelete={onDelete}
          onOpenFolder={onOpenFolder}
          onPreviewFolder={onPreviewFolder}
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
          <Plus size={15} /> {entity === "subjects" ? t('library.newSubject') : t('library.newChapter')}
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
  allChapterCourses,
  folders,
  itemOrder,
  chapter,
  onAdd,
  onAddFolder,
  onOrganize,
  onOpen,
  onEdit,
  onDelete,
  onOpenFolder,
  onPreviewFolder,
}: {
  courses: Course[];
  allChapterCourses: Course[];
  folders: CourseFolder[];
  itemOrder?: string[];
  chapter: Chapter;
  onAdd: (folderId?: number) => void;
  onAddFolder: () => void;
  onOrganize: () => void;
  onOpen: (course: Course) => void;
  onEdit: (entity: Entity, item: Course | CourseFolder) => void;
  onDelete: (entity: Entity, id: number, label: string) => void;
  onOpenFolder: (folderId: number) => void;
  onPreviewFolder: (folderId: number) => void;
}) {
  const { t } = useI18n();
  const itemOrderMap = new Map((itemOrder ?? []).map((key, index) => [key, index]));
  const orderedItems = [
    ...folders.map((item) => ({ type: "folder" as const, item })),
    ...courses.map((item) => ({ type: "course" as const, item })),
  ].sort((first, second) => {
    const firstPosition = itemOrderMap.get(`${first.type}:${first.item.id}`) ?? Number.MAX_SAFE_INTEGER;
    const secondPosition = itemOrderMap.get(`${second.type}:${second.item.id}`) ?? Number.MAX_SAFE_INTEGER;
    if (firstPosition !== secondPosition) return firstPosition - secondPosition;
    return first.item.created_at.localeCompare(second.item.created_at);
  });
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
        <button title={t('actions.edit')} onClick={(event) => { event.stopPropagation(); onEdit("courses", course); }}><Pencil size={15} /></button>
        <button title={t('actions.delete')} onClick={(event) => { event.stopPropagation(); onDelete("courses", course.id, course.title); }}><Trash2 size={15} /></button>
      </div>
    </article>
  );
  const renderFolder = (folder: CourseFolder) => {
    const folderCourses = allChapterCourses.filter((course) => course.folder_id === folder.id);
    return <div className="chapter-item-group" key={`folder-${folder.id}`}>
      <article className="course-row folder-row">
        <button className="course-open folder-open" onClick={() => onOpenFolder(folder.id)}>
          <div className="course-file"><Folder size={20} /></div>
          <div className="course-copy"><div><span className="course-label">{t('library.folderType')}</span><h3>{folder.name}</h3></div><small>{folderCourses.length} {t('library.coursesInFolder')}</small></div>
          <ChevronRight className="course-arrow" size={18} />
        </button>
        <div className="row-actions">
          <button title="Voir les cours" aria-label="Voir les cours" onClick={(event) => { event.stopPropagation(); onPreviewFolder(folder.id); }}><Eye size={15} /></button>
          <button title={t('actions.edit')} onClick={(event) => { event.stopPropagation(); onEdit('course_folders', folder); }}><Pencil size={15} /></button>
          <button title={t('actions.delete')} onClick={(event) => { event.stopPropagation(); onDelete('course_folders', folder.id, folder.name); }}><Trash2 size={15} /></button>
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
        <button className="small-button organize-button" onClick={onOrganize}>
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

function FolderDetail({
  folder,
  chapter,
  subject,
  courses,
  onBack,
  onOpenCourse,
  onAddCourse,
  onOrganize,
  onEdit,
  onDelete,
}: {
  folder?: CourseFolder;
  chapter?: Chapter;
  subject?: Subject;
  courses: Course[];
  onBack: () => void;
  onOpenCourse: (course: Course) => void;
  onAddCourse: () => void;
  onOrganize: () => void;
  onEdit: (entity: Entity, item: Course) => void;
  onDelete: (entity: Entity, id: number, label: string) => void;
}) {
  const { t } = useI18n();
  if (!folder) return null;
  const folderCourses = courses.filter((course) => course.folder_id === folder.id).sort(compareFolderCourses);
  return (
    <section className="folder-detail">
      <button className="back-button" onClick={onBack}><ArrowLeft size={17} /> Retour au chapitre</button>
      <div className="breadcrumbs">
        <span>{subject?.name}</span><ChevronRight size={15} />
        <span>{chapter?.name}</span><ChevronRight size={15} />
        <span>{folder.name}</span>
      </div>
      <div className="folder-detail-heading">
        <div className="folder-detail-title"><span className="folder-detail-icon"><Folder size={23} /></span><div><span className="course-label">DOSSIER DE COURS</span><h1 className="display-title">{folder.name}</h1><p>{folderCourses.length} cours</p></div></div>
        <div className="folder-detail-actions"><button className="small-button organize-button" onClick={onOrganize}><ArrowUpDown size={15} /> {t('actions.organize')}</button><button className="primary-button" onClick={onAddCourse}><Plus size={17} /> {t('library.newCourse')}</button></div>
      </div>
      {folderCourses.length ? (
        <div className="folder-course-list">
          {folderCourses.map((course) => (
            <article className="folder-course-row" key={course.id}>
              <button className="folder-course-open" onClick={() => onOpenCourse(course)}>
                <span className="module-row-icon"><FileText size={18} /></span>
                <span><strong>{course.title}</strong><small>{course.source_type === "demo" ? "Cours de démonstration" : "Cours"}</small></span>
                <ChevronRight size={17} />
              </button>
              <div className="row-actions">
                <button title="Modifier" aria-label="Modifier" onClick={(event) => { event.stopPropagation(); onEdit("courses", course); }}><Pencil size={15} /></button>
                <button title="Supprimer" aria-label="Supprimer" onClick={(event) => { event.stopPropagation(); onDelete("courses", course.id, course.title); }}><Trash2 size={15} /></button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">Ce dossier ne contient aucun cours.</div>
      )}
    </section>
  );
}

function FolderPreview({
  folder,
  courses,
  onClose,
  onOpenCourse,
}: {
  folder?: CourseFolder;
  courses: Course[];
  onClose: () => void;
  onOpenCourse: (course: Course) => void;
}) {
  if (!folder) return null;
  const folderCourses = courses.filter((course) => course.folder_id === folder.id).sort(compareFolderCourses);
  return (
    <div className="modal-backdrop folder-preview-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="folder-preview" role="dialog" aria-modal="true" aria-labelledby="folder-preview-title">
        <div className="folder-preview-head">
          <div className="folder-preview-title"><span className="folder-detail-icon"><Folder size={20} /></span><div><span className="course-label">DOSSIER DE COURS</span><h2 id="folder-preview-title">{folder.name}</h2></div></div>
          <button className="close-button" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </div>
        <p className="folder-preview-count">{folderCourses.length} cours</p>
        {folderCourses.length ? (
          <div className="folder-preview-list">
            {folderCourses.map((course) => (
              <button className="folder-preview-row" key={course.id} onClick={() => onOpenCourse(course)}>
                <FileText size={17} /><span>{course.title}</span><ChevronRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <div className="folder-preview-empty">Ce dossier ne contient aucun cours.</div>
        )}
        <div className="folder-preview-actions"><button className="secondary-button" onClick={onClose}>Fermer</button></div>
      </section>
    </div>
  );
}

function FolderCourseAddModal({
  folder,
  courses,
  onClose,
  onCreate,
  onAttach,
  onError,
}: {
  folder?: CourseFolder;
  courses: Course[];
  onClose: () => void;
  onCreate: () => void;
  onAttach: (folder: CourseFolder, courses: Course[]) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<"choice" | "existing">("choice");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, saving]);
  if (!folder) return null;
  const availableCourses = courses.filter((course) => course.chapter_id === folder.chapter_id && course.folder_id !== folder.id);
  const toggleCourse = (courseId: number) => {
    setSelectedIds((current) => current.includes(courseId) ? current.filter((id) => id !== courseId) : [...current, courseId]);
  };
  const attach = async () => {
    if (!selectedIds.length) return;
    setSaving(true);
    try {
      await onAttach(folder, availableCourses.filter((course) => selectedIds.includes(course.id)));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Impossible d’ajouter le cours.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section className="folder-add-modal" role="dialog" aria-modal="true" aria-labelledby="folder-add-title">
        <div className="modal-head">
          <div><span className="section-kicker">DOSSIER DE COURS</span><h2 id="folder-add-title">Ajouter un cours</h2></div>
          <button className="close-button" onClick={onClose} disabled={saving} aria-label="Fermer"><X size={18} /></button>
        </div>
        {mode === "choice" ? (
          <div className="folder-add-options">
            <button className="folder-add-option" onClick={() => setMode("existing")}>
              <span className="module-action-icon"><FileText size={19} /></span><span><strong>Ajouter un cours existant</strong><small>Rattacher un cours déjà présent dans ce chapitre</small></span><ChevronRight size={17} />
            </button>
            <button className="folder-add-option" onClick={onCreate}>
              <span className="module-action-icon"><Plus size={19} /></span><span><strong>Créer un nouveau cours</strong><small>Ouvrir l’éditeur dans ce dossier</small></span><ChevronRight size={17} />
            </button>
          </div>
        ) : (
          <>
            <p className="folder-add-intro">Sélectionne les cours du chapitre à ajouter à « {folder.name} ».</p>
            {availableCourses.length ? (
              <div className="folder-existing-list">
                {availableCourses.map((course) => (
                  <label className="folder-existing-option" key={course.id}>
                    <input type="checkbox" checked={selectedIds.includes(course.id)} onChange={() => toggleCourse(course.id)} />
                    <span><strong>{course.title}</strong><small>{course.folder_id === null ? "Cours directement dans le chapitre" : "Cours d’un autre dossier"}</small></span>
                  </label>
                ))}
              </div>
            ) : <div className="folder-add-empty">Aucun autre cours disponible dans ce chapitre.</div>}
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>Annuler</button><button type="button" className="primary-button" onClick={() => void attach()} disabled={!selectedIds.length || saving}>{saving ? "Ajout..." : "Ajouter"}</button></div>
          </>
        )}
      </section>
    </div>
  );
}

function CourseDetail({
  course,
  subjects,
  chapters,
  onBack,
  onStudy,
  onEdit,
  onDelete,
  onMoved,
}: {
  course: Course;
  subjects: Subject[];
  chapters: Chapter[];
  onBack: () => void;
  onStudy: () => void;
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
          <h1 className="display-title">{course.title}</h1>
          <p>
            {subject?.name} · {chapter?.name}
          </p>
        </div>
      </div>
      <div className="detail-actions">
        <button className="primary-button" onClick={onStudy}>
          <BrainCircuit size={16} /> Étudier
        </button>
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
      <CourseDocuments courseId={course.id} />
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
  onDocumentUploadComplete,
  onError,
}: {
  modal: NonNullable<ModalState>;
  subjects: Subject[];
  chapters: Chapter[];
  courseFolders: CourseFolder[];
  onClose: () => void;
  onSaved: (item?: Chapter | CourseFolder | Course) => Promise<void>;
  onDocumentUploadComplete?: (course: Course) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const item = modal.item;
  const isEdit = Boolean(item);
  const entity = modal.entity;
  const folderContextLocked = entity === "courses" && modal.folderId !== undefined;
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
  const [documentFiles, setDocumentFiles] = useState<File[]>([]);
  const [createdCourse, setCreatedCourse] = useState<Course | null>(null);
  const [documentUploadProgress, setDocumentUploadProgress] = useState<CourseDocumentUploadProgress | null>(null);
  const [documentUploadState, setDocumentUploadState] = useState<'idle' | 'uploading' | 'complete' | 'failed' | 'cancelled'>('idle');
  const [documentUploadError, setDocumentUploadError] = useState<string | null>(null);
  const [uploadingDocuments, setUploadingDocuments] = useState(false);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const documentUploadController = useRef<AbortController | null>(null);
  const courseChapters = chapters
    .filter((chapter) => chapter.subject_id === courseSubjectId)
    .sort(comparePositionedItems);
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
  const selectCourseDocuments = (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const selected = [...documentFiles, ...Array.from(fileList)];
    if (selected.length > 10) {
      setDocumentUploadError('10 fichiers maximum par import.');
      return;
    }
    if (selected.some((file) => file.size <= 0 || file.size > 20 * 1024 * 1024)) {
      setDocumentUploadError('Chaque fichier doit peser entre 1 octet et 20 Mo.');
      return;
    }
    if (selected.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) {
      setDocumentUploadError('Un import groupé ne peut pas dépasser 50 Mo.');
      return;
    }
    const acceptedTypes: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
      '.pdf': 'application/pdf', '.txt': 'text/plain', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const unsupported = Array.from(fileList).find((file) => {
      const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      return acceptedTypes[extension] !== file.type;
    });
    if (unsupported) {
      setDocumentUploadError(`Format ou type MIME non accepté : ${unsupported.name}`);
      return;
    }
    setDocumentUploadError(null);
    setDocumentFiles(selected);
  };
  const closeEditor = () => {
    if (uploadingDocuments) {
      documentUploadController.current?.abort();
      return;
    }
    if (createdCourse) void onSaved(createdCourse);
    else onClose();
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (uploadingDocuments) return;
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
          if (!isEdit && documentFiles.length) {
            setUploadingDocuments(true);
            setDocumentUploadState('uploading');
            setDocumentUploadError(null);
            setDocumentUploadProgress(null);
            const controller = new AbortController();
            documentUploadController.current = controller;
            try {
              const workflow = await createCourseWithDocuments({
                createCourse: async () => {
                  let course = createdCourse
                    ? await api.updateCourse(createdCourse, fields)
                    : await api.createCourse(folderContextLocked ? { ...fields, folder_id: null } : fields);
                  if (!createdCourse) setCreatedCourse(course);
                  if (folderContextLocked && modal.folderId !== null && modal.folderId !== undefined && course.folder_id === null) {
                    course = await api.appendCourseToFolder(course, modal.folderId);
                  }
                  setCreatedCourse(course);
                  return course;
                },
                files: [...documentFiles],
                signal: controller.signal,
                uploadFile: (courseId, file, signal, onProgress) => api.uploadCourseDocuments(
                  courseId,
                  [file],
                  onProgress,
                  signal,
                ),
                onProgress: setDocumentUploadProgress,
                onDocumentUploaded: (file) => setDocumentFiles((current) => current.filter((candidate) => candidate !== file)),
              });
              setDocumentUploadState('complete');
              await onSaved(workflow.course);
              onDocumentUploadComplete?.(workflow.course);
            } catch (uploadError) {
              if (uploadError instanceof CourseDocumentWorkflowError) {
                setCreatedCourse(uploadError.course);
                if (uploadError.cancelled) {
                  const remaining = removeCancelledUpload(uploadError.remainingFiles, uploadError.failedFile);
                  setDocumentFiles(remaining);
                  setDocumentUploadState(remaining.length ? 'cancelled' : 'idle');
                  if (!remaining.length) {
                    await onSaved(uploadError.course);
                    onDocumentUploadComplete?.(uploadError.course);
                  }
                } else {
                  setDocumentFiles(uploadError.remainingFiles);
                  setDocumentUploadState('failed');
                  setDocumentUploadError(uploadError.message);
                }
              } else {
                setDocumentUploadState('failed');
                setDocumentUploadError(uploadError instanceof Error ? uploadError.message : 'Import documentaire impossible.');
              }
            } finally {
              documentUploadController.current = null;
              setUploadingDocuments(false);
            }
            return;
          }
          let savedCourse = isEdit
            ? await api.updateCourse(item as Course, fields)
            : createdCourse
              ? await api.updateCourse(createdCourse, fields)
              : await api.createCourse(folderContextLocked ? { ...fields, folder_id: null } : fields);
          if (!isEdit && folderContextLocked && modal.folderId !== null && modal.folderId !== undefined && savedCourse.folder_id === null) {
            savedCourse = await api.appendCourseToFolder(savedCourse, modal.folderId);
          }
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
          <button type="button" className="close-button" onClick={closeEditor}>
            <X size={18} />
          </button>
        </div>
        {entity === "courses" ? (
          <div className="dependent-fields">
            <label>
              {t('editor.subject')}
              <select
                value={courseSubjectId}
                disabled={folderContextLocked}
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
                disabled={folderContextLocked}
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
                disabled={folderContextLocked}
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
            {!isEdit && (
              <div className="create-course-documents">
                <div className="create-course-documents-heading">
                  <strong>Documents originaux</strong>
                  <button type="button" className="small-button" onClick={() => documentInputRef.current?.click()} disabled={uploadingDocuments}>
                    <Upload size={15} /> Ajouter des documents
                  </button>
                  <input
                    ref={documentInputRef}
                    className="course-documents-input"
                    type="file"
                    multiple
                    accept=".jpg,.jpeg,.png,.webp,.pdf,.txt,.docx"
                    onChange={(event) => {
                      selectCourseDocuments(event.currentTarget.files);
                      event.currentTarget.value = '';
                    }}
                  />
                </div>
                {documentFiles.length > 0 && <ul className="create-course-document-list">
                  {documentFiles.map((file, index) => (
                    <li key={`${file.name}-${file.lastModified}-${index}`}>
                      <span>{file.name}</span>
                      <small>{new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(file.size / 1024)} Ko</small>
                      <button type="button" className="icon-button" aria-label={`Retirer ${file.name}`} disabled={uploadingDocuments} onClick={() => setDocumentFiles((current) => current.filter((candidate) => candidate !== file))}><X size={15} /></button>
                    </li>
                  ))}
                </ul>}
                {uploadingDocuments && documentUploadProgress && <div className="course-document-progress">
                  <progress value={documentUploadProgress.percent} max={100} aria-label="Progression du transfert" />
                  <span>{documentUploadProgress.percent}% · {documentUploadProgress.phase === 'saved' ? `${documentUploadProgress.filename} enregistré` : documentUploadProgress.phase === 'saving' ? `Enregistrement de ${documentUploadProgress.filename}…` : `Transfert ${documentUploadProgress.fileIndex}/${documentUploadProgress.fileCount}`}</span>
                </div>}
                {documentUploadState === 'cancelled' && <p className="course-document-result">Import annulé. Le cours et les documents déjà enregistrés sont conservés.</p>}
                {documentUploadState === 'failed' && <p className="course-document-result is-failed">Le cours est créé. Les fichiers restants peuvent être réessayés.</p>}
                {documentUploadState === 'complete' && <p className="course-document-result is-success">Import terminé.</p>}
                {documentUploadError && <p className="course-documents-error" role="alert">{documentUploadError}</p>}
              </div>
            )}
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={closeEditor}>
            {uploadingDocuments ? 'Annuler l’import' : createdCourse ? 'Fermer, garder le cours' : t('actions.cancel')}
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={(entity === "courses" && !parentId) || uploadingDocuments}
          >
            {documentFiles.length && documentUploadState === 'failed' ? 'Réessayer les fichiers restants' : documentFiles.length && documentUploadState === 'cancelled' ? 'Reprendre l’import des fichiers' : isEdit ? t('actions.save') : createdCourse ? 'Enregistrer le cours' : t('actions.create')}
          </button>
        </div>
      </form>
    </div>
  );
}

export default App;
