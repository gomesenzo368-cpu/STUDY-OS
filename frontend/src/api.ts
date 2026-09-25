import type { Chapter, ChapterItem, ChapterItemCreateFields, ChapterItemKey, Course, CourseFolder, MixedChapterItem, ReorderChapterItemPayload, ReorderChapterItemsPayload, Subject } from './types'
import { supabase } from './lib/supabase'

const API_URL = import.meta.env.VITE_API_URL ?? '/api'

type SubjectFields = Pick<Subject, 'name' | 'description' | 'color' | 'icon'>
type ChapterFields = Pick<Chapter, 'subject_id' | 'name' | 'description'>
type CourseFolderFields = Pick<CourseFolder, 'chapter_id' | 'name'>
type CourseFields = Pick<Course, 'chapter_id' | 'folder_id' | 'title' | 'content' | 'original_content' | 'source_type'>
type ChapterItemRow = Pick<ChapterItem, 'id' | 'chapter_id' | 'user_id' | 'course_id' | 'folder_id' | 'position' | 'created_at' | 'updated_at'>
type SupabaseError = { message: string; code?: string; details?: string; hint?: string }

function throwSupabaseError(resource: string, operation: string, error: SupabaseError): never {
  const context = { message: error.message, code: error.code, details: error.details, hint: error.hint }
  console.error(`[${resource}] ${operation} failed`, context)
  throw Object.assign(new Error(error.message), context)
}

async function getAuthenticatedUser() {
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error) throwSupabaseError('auth', 'get user', error)
  if (!user) throw new Error('Aucun utilisateur Supabase connecté.')
  return user
}

async function loadChapterItems(chapterId: number): Promise<MixedChapterItem[]> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase
    .from('chapter_items')
    .select('id, chapter_id, user_id, course_id, folder_id, position, created_at, updated_at')
    .eq('chapter_id', chapterId)
    .eq('user_id', user.id)
    .order('position', { ascending: true })
  if (error) throwSupabaseError('chapter_items', 'select', error)

  const rows = (data ?? []) as ChapterItemRow[]
  const courseIds = rows.flatMap((row) => row.course_id === null ? [] : [row.course_id])
  const folderIds = rows.flatMap((row) => row.folder_id === null ? [] : [row.folder_id])
  const [{ data: courses, error: coursesError }, { data: folders, error: foldersError }] = await Promise.all([
    courseIds.length
      ? supabase.from('courses').select('id, user_id, chapter_id, folder_id, title, content, original_content, source_type, created_at, updated_at').eq('user_id', user.id).eq('chapter_id', chapterId).in('id', courseIds)
      : Promise.resolve({ data: [], error: null }),
    folderIds.length
      ? supabase.from('course_folders').select('id, user_id, chapter_id, name, created_at, updated_at').eq('user_id', user.id).eq('chapter_id', chapterId).in('id', folderIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (coursesError) throwSupabaseError('courses', 'select chapter items', coursesError)
  if (foldersError) throwSupabaseError('course_folders', 'select chapter items', foldersError)

  const coursesById = new Map((courses as Course[]).map((course) => [course.id, course]))
  const foldersById = new Map((folders as CourseFolder[]).map((folder) => [folder.id, folder]))
  return rows.map((row) => {
    if (row.course_id !== null) {
      const course = coursesById.get(row.course_id)
      if (!course) throw new Error(`Le cours ${row.course_id} référencé par chapter_items est introuvable.`)
      return { type: 'course', id: course.id, chapter_item_id: row.id, position: row.position, course }
    }
    if (row.folder_id !== null) {
      const folder = foldersById.get(row.folder_id)
      if (!folder) throw new Error(`Le dossier ${row.folder_id} référencé par chapter_items est introuvable.`)
      return { type: 'folder', id: folder.id, chapter_item_id: row.id, position: row.position, folder }
    }
    throw new Error(`La ligne chapter_items ${row.id} ne référence aucun élément.`)
  })
}

async function reorderChapterItems(chapterId: number, items: readonly string[]): Promise<void> {
  const payload: ReorderChapterItemPayload[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const separatorIndex = item.indexOf(':')
    const typeRaw = separatorIndex >= 0 ? item.slice(0, separatorIndex) : ''
    const idRaw = separatorIndex >= 0 ? item.slice(separatorIndex + 1) : ''
    const id = Number(idRaw)
    const normalizedType = typeRaw === 'course' || typeRaw === 'folder' ? typeRaw : null

    if (!normalizedType || !Number.isInteger(id) || id <= 0) {
      throw new Error('La liste d’organisation contient un élément invalide.')
    }

    const key = `${normalizedType}:${id}`
    if (seen.has(key)) {
      throw new Error('La liste chapter_items contient des éléments dupliqués.')
    }
    seen.add(key)
    payload.push({ type: normalizedType, id })
  }

  const { error } = await supabase.rpc('reorder_chapter_items', {
    p_chapter_id: chapterId,
    p_items: payload,
  })

  if (error) throwSupabaseError('reorder_chapter_items', 'rpc', error)
}

async function createChapterItem(fields: ChapterItemCreateFields): Promise<ChapterItem> {
  const user = await getAuthenticatedUser()
  const hasCourse = fields.course_id !== null
  const hasFolder = fields.folder_id !== null
  if (hasCourse === hasFolder) throw new Error('Une ligne chapter_items doit référencer exactement un cours ou un dossier.')
  const { data, error } = await supabase.from('chapter_items').insert({ user_id: user.id, ...fields }).select().single()
  if (error) throwSupabaseError('chapter_items', 'insert', error)
  return data as ChapterItem
}

async function deleteChapterItem(id: number): Promise<void> {
  const user = await getAuthenticatedUser()
  const { error } = await supabase.from('chapter_items').delete().eq('id', id).eq('user_id', user.id)
  if (error) throwSupabaseError('chapter_items', 'delete', error)
}

async function loadSubjects(): Promise<Subject[]> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase
    .from('subjects')
    .select('id, user_id, name, description, color, icon, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
  if (error) throwSupabaseError('subjects', 'select', error)
  return (data ?? []) as Subject[]
}

async function createSubject(fields: SubjectFields): Promise<Subject> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('subjects').insert({ user_id: user.id, ...fields }).select().single()
  if (error) throwSupabaseError('subjects', 'insert', error)
  return data as Subject
}

async function updateSubject(subject: Subject, fields: SubjectFields): Promise<Subject> {
  await getAuthenticatedUser()
  const { data, error } = await supabase.from('subjects').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', subject.id).select()
  if (error) throwSupabaseError('subjects', 'update', error)
  if (!data || data.length !== 1) {
    throw new Error(`La matière ${subject.id} n'a pas pu être mise à jour : Supabase a retourné ${data?.length ?? 0} ligne.`)
  }
  return data[0] as Subject
}

async function deleteSubject(id: number): Promise<void> {
  const user = await getAuthenticatedUser()
  const { error } = await supabase.from('subjects').delete().eq('id', id).eq('user_id', user.id)
  if (error) throwSupabaseError('subjects', 'delete', error)
}

async function getChapters(subjectId?: number): Promise<Chapter[]> {
  const user = await getAuthenticatedUser()
  let query = supabase.from('chapters').select('id, user_id, subject_id, name, description, created_at, updated_at').eq('user_id', user.id).order('created_at', { ascending: true })
  if (subjectId !== undefined) query = query.eq('subject_id', subjectId)
  const { data, error } = await query
  if (error) throwSupabaseError('chapters', 'select', error)
  return (data ?? []) as Chapter[]
}

async function createChapter(fields: ChapterFields): Promise<Chapter> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('chapters').insert({ user_id: user.id, ...fields }).select().single()
  if (error) throwSupabaseError('chapters', 'insert', error)
  return data as Chapter
}

async function updateChapter(chapter: Chapter, fields: ChapterFields): Promise<Chapter> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('chapters').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', chapter.id).eq('user_id', user.id).select().single()
  if (error) throwSupabaseError('chapters', 'update', error)
  return data as Chapter
}

async function deleteChapter(id: number): Promise<void> {
  const user = await getAuthenticatedUser()
  const { error } = await supabase.from('chapters').delete().eq('id', id).eq('user_id', user.id)
  if (error) throwSupabaseError('chapters', 'delete', error)
}

async function loadCourseFolders(): Promise<CourseFolder[]> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('course_folders').select('id, user_id, chapter_id, name, created_at, updated_at').eq('user_id', user.id).order('created_at', { ascending: true })
  if (error) throwSupabaseError('course_folders', 'select', error)
  return (data ?? []) as CourseFolder[]
}

async function createCourseFolder(fields: CourseFolderFields): Promise<CourseFolder> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('course_folders').insert({ user_id: user.id, ...fields }).select().single()
  if (error) throwSupabaseError('course_folders', 'insert', error)
  return data as CourseFolder
}

async function updateCourseFolder(folder: CourseFolder, fields: CourseFolderFields): Promise<CourseFolder> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('course_folders').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', folder.id).eq('user_id', user.id).select().single()
  if (error) throwSupabaseError('course_folders', 'update', error)
  return data as CourseFolder
}

async function deleteCourseFolder(id: number): Promise<void> {
  const user = await getAuthenticatedUser()
  const { error } = await supabase.from('course_folders').delete().eq('id', id).eq('user_id', user.id)
  if (error) throwSupabaseError('course_folders', 'delete', error)
}

async function loadCourses(): Promise<Course[]> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('courses').select('id, user_id, chapter_id, folder_id, title, content, original_content, source_type, created_at, updated_at').eq('user_id', user.id).order('created_at', { ascending: true })
  if (error) throwSupabaseError('courses', 'select', error)
  return (data ?? []) as Course[]
}

async function createCourse(fields: CourseFields): Promise<Course> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('courses').insert({ user_id: user.id, ...fields }).select().single()
  if (error) throwSupabaseError('courses', 'insert', error)
  return data as Course
}

async function updateCourse(course: Course, fields: CourseFields): Promise<Course> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('courses').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', course.id).eq('user_id', user.id).select().single()
  if (error) throwSupabaseError('courses', 'update', error)
  return data as Course
}

async function deleteCourse(id: number): Promise<void> {
  const user = await getAuthenticatedUser()
  const { error } = await supabase.from('courses').delete().eq('id', id).eq('user_id', user.id)
  if (error) throwSupabaseError('courses', 'delete', error)
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession()
  if (!data.session?.access_token) throw new Error('Ta session a expiré. Reconnecte-toi pour continuer.')
  const response = await fetch(`${API_URL}${path}`, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}`, ...options?.headers }, ...options })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: 'Une erreur est survenue.' }))
    throw new Error(body.detail ?? 'Une erreur est survenue.')
  }
  return response.status === 204 ? (undefined as T) : response.json()
}

export const api = {
  chapterItems: loadChapterItems,
  reorderChapterItems,
  createChapterItem,
  deleteChapterItem,
  subjects: loadSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  getChapters,
  createChapter,
  updateChapter,
  deleteChapter,
  courseFolders: loadCourseFolders,
  createCourseFolder,
  updateCourseFolder,
  deleteCourseFolder,
  courses: loadCourses,
  createCourse,
  updateCourse,
  deleteCourse,
  create: <T>(entity: string, body: object) => request<T>(`/${entity}`, { method: 'POST', body: JSON.stringify(body) }),
  update: <T>(entity: string, id: number, body: object) => request<T>(`/${entity}/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  remove: (entity: string, id: number) => request<void>(`/${entity}/${id}`, { method: 'DELETE' }),
  importFile: async (file: File) => {
    const { data } = await supabase.auth.getSession()
    if (!data.session?.access_token) throw new Error('Ta session a expiré. Reconnecte-toi pour continuer.')
    const response = await fetch(`${API_URL}/courses/import`, { method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}` }, body: (() => { const form = new FormData(); form.append('file', file); return form })() })
    if (!response.ok) { const body = await response.json().catch(() => ({ detail: 'Import impossible.' })); throw new Error(body.detail ?? 'Import impossible.') }
    return response.json() as Promise<{ filename: string; content: string; source_type: string }>
  },
}
