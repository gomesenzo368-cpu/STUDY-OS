import type { Chapter, ChapterItem, ChapterItemCreateFields, ChapterItemKey, Course, CourseDocument, CourseFolder, MixedChapterItem, PlanningCalendarBlock, PlanningCalendarBlockFields, PlanningException, PlanningExceptionFields, PlanningSeries, PlanningSeriesFields, PlanningYear, PlanningYearFields, ReorderChapterItemPayload, ReorderChapterItemsPayload, RevisionAnswerResult, RevisionReviewItem, RevisionSession, Subject } from './types'
import { supabase } from './lib/supabase'

const API_URL = import.meta.env.VITE_API_URL ?? '/api'

export type AIChatResponse = {
  status: 'completed' | 'unavailable' | 'error'
  message: string | null
  error_code: string | null
  provider: string | null
  provider_failures: { provider: string; error_code: string; retryable: boolean }[]
}

type SubjectFields = Pick<Subject, 'name' | 'description' | 'color' | 'icon'>
type ChapterFields = Pick<Chapter, 'subject_id' | 'name' | 'description'>
type CourseFolderFields = Pick<CourseFolder, 'chapter_id' | 'name'>
type CourseFields = Pick<Course, 'chapter_id' | 'folder_id' | 'title' | 'content' | 'original_content' | 'source_type'>
type PlanningExceptionUpsertFields = PlanningExceptionFields
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
    .select('id, user_id, name, description, color, icon, position, created_at, updated_at')
    .eq('user_id', user.id)
    .order('position', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) throwSupabaseError('subjects', 'select', error)
  return (data ?? []) as Subject[]
}

async function reorderSubjects(ids: readonly number[]): Promise<void> {
  const { error } = await supabase.rpc('reorder_subjects', {
    p_items: ids.map((id) => ({ id })),
  })
  if (error) throwSupabaseError('subjects', 'reorder', error)
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
  const { data: chapters, error: chaptersError } = await supabase.from('chapters').select('id').eq('subject_id', id).eq('user_id', user.id)
  if (chaptersError) throwSupabaseError('chapters', 'select before subject delete', chaptersError)
  const chapterIds = (chapters ?? []).map((chapter) => chapter.id)
  if (chapterIds.length) {
    const { data: courses, error: coursesError } = await supabase.from('courses').select('id').eq('user_id', user.id).in('chapter_id', chapterIds)
    if (coursesError) throwSupabaseError('courses', 'select before subject delete', coursesError)
    await Promise.all((courses ?? []).map((course) => deleteCourseDocuments(course.id)))
  }
  const { error } = await supabase.from('subjects').delete().eq('id', id).eq('user_id', user.id)
  if (error) throwSupabaseError('subjects', 'delete', error)
}

async function getChapters(subjectId?: number): Promise<Chapter[]> {
  const user = await getAuthenticatedUser()
  let query = supabase
    .from('chapters')
    .select('id, user_id, subject_id, name, description, position, created_at, updated_at')
    .eq('user_id', user.id)
    .order('position', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (subjectId !== undefined) query = query.eq('subject_id', subjectId)
  const { data, error } = await query
  if (error) throwSupabaseError('chapters', 'select', error)
  return (data ?? []) as Chapter[]
}

async function reorderChapters(subjectId: number, ids: readonly number[]): Promise<void> {
  const { error } = await supabase.rpc('reorder_chapters', {
    p_subject_id: subjectId,
    p_items: ids.map((id) => ({ id })),
  })
  if (error) throwSupabaseError('chapters', 'reorder', error)
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
  const { data: courses, error: coursesError } = await supabase.from('courses').select('id').eq('chapter_id', id).eq('user_id', user.id)
  if (coursesError) throwSupabaseError('courses', 'select before chapter delete', coursesError)
  await Promise.all((courses ?? []).map((course) => deleteCourseDocuments(course.id)))
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
  const selectWithFolderPosition = 'id, user_id, chapter_id, folder_id, folder_position, title, content, original_content, source_type, created_at, updated_at'
  const selectLegacy = 'id, user_id, chapter_id, folder_id, title, content, original_content, source_type, created_at, updated_at'
  const firstQuery = await supabase.from('courses').select(selectWithFolderPosition).eq('user_id', user.id).order('created_at', { ascending: true })
  if (!firstQuery.error) return (firstQuery.data ?? []) as Course[]
  if (firstQuery.error.code !== '42703' && !firstQuery.error.message.includes('folder_position')) {
    throwSupabaseError('courses', 'select', firstQuery.error)
  }
  const legacyQuery = await supabase.from('courses').select(selectLegacy).eq('user_id', user.id).order('created_at', { ascending: true })
  if (legacyQuery.error) throwSupabaseError('courses', 'select', legacyQuery.error)
  return (legacyQuery.data ?? []).map((course) => ({ ...course, folder_position: null })) as Course[]
}

async function reorderFolderCourses(folderId: number, ids: readonly number[]): Promise<void> {
  const { error } = await supabase.rpc('reorder_folder_courses', {
    p_folder_id: folderId,
    p_items: ids.map((id) => ({ id })),
  })
  if (error) throwSupabaseError('courses', 'reorder folder', error)
}

async function appendCourseToFolder(course: Course, folderId: number): Promise<Course> {
  const { error } = await supabase.rpc('append_course_to_folder', {
    p_course_id: course.id,
    p_folder_id: folderId,
  })
  if (!error) return { ...course, folder_id: folderId, folder_position: null }
  if (error.code !== '42883' && error.code !== '42703' && !error.message.includes('append_course_to_folder')) {
    throwSupabaseError('courses', 'append to folder', error)
  }
  const updated = await updateCourse(course, {
    chapter_id: course.chapter_id,
    folder_id: folderId,
    title: course.title,
    content: course.content,
    original_content: course.original_content,
    source_type: course.source_type,
  })
  return { ...updated, folder_position: null }
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
  await deleteCourseDocuments(id)
  const { error } = await supabase.from('courses').delete().eq('id', id).eq('user_id', user.id)
  if (error) throwSupabaseError('courses', 'delete', error)
}

async function getPlanningYears(): Promise<PlanningYear[]> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('planning_years').select('*').eq('user_id', user.id).order('starts_on', { ascending: false }).order('id', { ascending: false })
  if (error) throwSupabaseError('planning_years', 'select', error)
  return (data ?? []) as PlanningYear[]
}

async function createPlanningYear(fields: PlanningYearFields): Promise<PlanningYear> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('planning_years').insert({ user_id: user.id, ...fields }).select().single()
  if (error) throwSupabaseError('planning_years', 'insert', error)
  return data as PlanningYear
}

async function updatePlanningYear(id: number, fields: PlanningYearFields): Promise<PlanningYear> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('planning_years').update(fields).eq('id', id).eq('user_id', user.id).select().single()
  if (error) throwSupabaseError('planning_years', 'update', error)
  return data as PlanningYear
}

async function deletePlanningYear(id: number): Promise<void> {
  const user = await getAuthenticatedUser()
  const { error } = await supabase.from('planning_years').delete().eq('id', id).eq('user_id', user.id)
  if (error) throwSupabaseError('planning_years', 'delete', error)
}

async function getPlanningCalendarBlocks(yearId: number): Promise<PlanningCalendarBlock[]> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('planning_calendar_blocks').select('*').eq('user_id', user.id).eq('year_id', yearId).order('starts_on', { ascending: true }).order('id', { ascending: true })
  if (error) throwSupabaseError('planning_calendar_blocks', 'select', error)
  return (data ?? []) as PlanningCalendarBlock[]
}

async function createPlanningCalendarBlock(fields: PlanningCalendarBlockFields): Promise<PlanningCalendarBlock> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('planning_calendar_blocks').insert({ user_id: user.id, ...fields }).select().single()
  if (error) throwSupabaseError('planning_calendar_blocks', 'insert', error)
  return data as PlanningCalendarBlock
}

async function updatePlanningCalendarBlock(id: number, fields: PlanningCalendarBlockFields): Promise<PlanningCalendarBlock> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('planning_calendar_blocks').update(fields).eq('id', id).eq('user_id', user.id).select().single()
  if (error) throwSupabaseError('planning_calendar_blocks', 'update', error)
  return data as PlanningCalendarBlock
}

async function deletePlanningCalendarBlock(id: number): Promise<void> {
  const user = await getAuthenticatedUser()
  const { error } = await supabase.from('planning_calendar_blocks').delete().eq('id', id).eq('user_id', user.id)
  if (error) throwSupabaseError('planning_calendar_blocks', 'delete', error)
}

async function getPlanningSeries(yearId: number): Promise<PlanningSeries[]> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('planning_series').select('*').eq('user_id', user.id).eq('year_id', yearId).order('day_of_week', { ascending: true }).order('start_time', { ascending: true })
  if (error) throwSupabaseError('planning_series', 'select', error)
  return (data ?? []) as PlanningSeries[]
}

async function createPlanningSeries(fields: PlanningSeriesFields): Promise<PlanningSeries> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('planning_series').insert({ user_id: user.id, ...fields }).select().single()
  if (error) throwSupabaseError('planning_series', 'insert', error)
  return data as PlanningSeries
}

async function updatePlanningSeries(id: number, fields: PlanningSeriesFields): Promise<PlanningSeries> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('planning_series').update(fields).eq('id', id).eq('user_id', user.id).select().single()
  if (error) throwSupabaseError('planning_series', 'update', error)
  return data as PlanningSeries
}

async function deletePlanningSeries(id: number): Promise<void> {
  const user = await getAuthenticatedUser()
  const { error } = await supabase.from('planning_series').delete().eq('id', id).eq('user_id', user.id)
  if (error) throwSupabaseError('planning_series', 'delete', error)
}

async function getPlanningExceptions(seriesIds?: readonly number[]): Promise<PlanningException[]> {
  const user = await getAuthenticatedUser()
  if (seriesIds && seriesIds.length === 0) return []
  let query = supabase.from('planning_exceptions').select('*').eq('user_id', user.id).order('occurrence_date', { ascending: true })
  if (seriesIds) query = query.in('series_id', [...seriesIds])
  const { data, error } = await query
  if (error) throwSupabaseError('planning_exceptions', 'select', error)
  return (data ?? []) as PlanningException[]
}

async function upsertPlanningException(fields: PlanningExceptionUpsertFields): Promise<PlanningException> {
  const user = await getAuthenticatedUser()
  const { data, error } = await supabase.from('planning_exceptions').upsert({ user_id: user.id, ...fields }, { onConflict: 'series_id,occurrence_date' }).select().single()
  if (error) throwSupabaseError('planning_exceptions', 'upsert', error)
  return data as PlanningException
}

async function deletePlanningException(id: number): Promise<void> {
  const user = await getAuthenticatedUser()
  const { error } = await supabase.from('planning_exceptions').delete().eq('id', id).eq('user_id', user.id)
  if (error) throwSupabaseError('planning_exceptions', 'delete', error)
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession()
  if (!data.session?.access_token) throw new Error('Ta session a expiré. Reconnecte-toi pour continuer.')
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}`, ...options?.headers }, ...options })
  } catch {
    throw new Error('Impossible de joindre le serveur API. Vérifie que le backend FastAPI est démarré.')
  }
  if (!response.ok) {
    const responseText = await response.text()
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(responseText)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
    } catch {
      // A proxy failure may return plain text instead of FastAPI's JSON error body.
    }
    const detail = body.detail
    const validationMessage = Array.isArray(detail)
      ? detail.map((entry) => typeof entry === 'object' && entry !== null && 'msg' in entry ? String(entry.msg) : '').filter(Boolean).join('; ')
      : ''
    const message = typeof detail === 'string'
      ? detail
      : validationMessage || (typeof body.error_code === 'string' ? body.error_code : '')
    if (!message) {
      const isServerError = response.status >= 500
      const fallback = isServerError
        ? `Le serveur API est indisponible (HTTP ${response.status}). Vérifie que le backend FastAPI est démarré.`
        : `Le serveur API a répondu HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`
      throw new Error(responseText.trim() ? `${fallback} ${responseText.trim().slice(0, 240)}` : fallback)
    }
    throw new Error(message)
  }
  return response.status === 204 ? (undefined as T) : response.json()
}

async function requestCourseDocuments<T>(path: string, options?: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession()
  if (!data.session?.access_token) throw new Error('Ta session a expiré. Reconnecte-toi pour continuer.')
  const method = options?.method ?? 'GET'
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${data.session.access_token}`, ...options?.headers },
      ...options,
    })
  } catch {
    throw new Error(`${method} ${API_URL}${path} : impossible de joindre le serveur API.`)
  }
  if (!response.ok) {
    const responseText = await response.text()
    let detail = responseText.trim()
    try {
      const body: unknown = JSON.parse(responseText)
      if (typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string') detail = body.detail
    } catch {
      // Preserve plain-text proxy and backend responses for document diagnostics.
    }
    throw new Error(`${method} ${API_URL}${path} → HTTP ${response.status}${detail ? ` : ${detail}` : ''}`)
  }
  return response.status === 204 ? (undefined as T) : response.json()
}

async function askAssistant(message: string): Promise<AIChatResponse> {
  return request<AIChatResponse>('/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
}

async function startRevisionSession(courseId: number): Promise<RevisionSession> {
  return request<RevisionSession>('/revisions/sessions', {
    method: 'POST',
    body: JSON.stringify({ course_id: courseId }),
  })
}

async function getRevisionSessions(): Promise<RevisionSession[]> {
  return request<RevisionSession[]>('/revisions/sessions?limit=50')
}

async function getRevisionRecommendations(): Promise<RevisionReviewItem[]> {
  return request<RevisionReviewItem[]>('/revisions/review?limit=100')
}

async function getRevisionSession(sessionId: number): Promise<RevisionSession> {
  return request<RevisionSession>(`/revisions/sessions/${sessionId}`)
}

async function submitRevisionAnswer(sessionId: number, questionId: number, answer: unknown): Promise<RevisionAnswerResult> {
  return request<RevisionAnswerResult>(`/revisions/sessions/${sessionId}/answers`, {
    method: 'POST',
    body: JSON.stringify({ question_id: questionId, answer }),
  })
}

async function closeRevisionSession(sessionId: number, status: 'complete' | 'abandon'): Promise<void> {
  return request<void>(`/revisions/sessions/${sessionId}/${status}`, { method: 'POST' })
}

async function getCourseDocuments(courseId: number): Promise<CourseDocument[]> {
  return requestCourseDocuments<CourseDocument[]>(`/courses/${courseId}/documents`)
}

export type CourseDocumentUploadProgress = {
  percent: number
  phase: 'transferring' | 'saving' | 'saved'
  fileIndex: number
  fileCount: number
  filename: string
}

async function uploadCourseDocuments(
  courseId: number,
  files: readonly File[],
  onProgress: (progress: CourseDocumentUploadProgress) => void,
  signal?: AbortSignal,
): Promise<CourseDocument[]> {
  const { data } = await supabase.auth.getSession()
  if (!data.session?.access_token) throw new Error('Ta session a expiré. Reconnecte-toi pour continuer.')
  const totalBytes = files.reduce((total, file) => total + file.size, 0)
  let completedBytes = 0
  const uploaded: CourseDocument[] = []

  for (const [index, file] of files.entries()) {
    if (signal?.aborted) throw new DOMException('Import annulé.', 'AbortError')
    const form = new FormData()
    form.append('files', file)
    const path = `/courses/${courseId}/documents`
    const url = `${API_URL}${path}`
    const result = await new Promise<CourseDocument[]>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const cleanup = () => signal?.removeEventListener('abort', abortRequest)
      const abortRequest = () => xhr.abort()
      xhr.open('POST', url)
      xhr.setRequestHeader('Authorization', `Bearer ${data.session?.access_token}`)
      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable || totalBytes === 0) return
        const fraction = Math.min(1, event.loaded / event.total)
        onProgress({
          percent: Math.min(99, Math.round((completedBytes + file.size * fraction) / totalBytes * 100)),
          phase: 'transferring',
          fileIndex: index + 1,
          fileCount: files.length,
          filename: file.name,
        })
      })
      xhr.upload.addEventListener('load', () => onProgress({
        percent: Math.min(99, Math.round((completedBytes + file.size) / totalBytes * 100)),
        phase: 'saving',
        fileIndex: index + 1,
        fileCount: files.length,
        filename: file.name,
      }))
      xhr.addEventListener('load', () => {
        cleanup()
        let body: unknown
        try {
          body = JSON.parse(xhr.responseText)
        } catch {
          body = null
        }
        if (xhr.status >= 200 && xhr.status < 300 && Array.isArray(body)) {
          const confirmedBytes = completedBytes + file.size
          onProgress({
            percent: Math.min(100, Math.round(confirmedBytes / totalBytes * 100)),
            phase: 'saved',
            fileIndex: index + 1,
            fileCount: files.length,
            filename: file.name,
          })
          resolve(body as CourseDocument[])
          return
        }
        const detail = typeof body === 'object' && body !== null && 'detail' in body && typeof body.detail === 'string'
          ? body.detail
          : xhr.responseText.trim() || xhr.statusText || 'Réponse vide du serveur.'
        reject(new Error(`POST ${url} → HTTP ${xhr.status}${detail ? ` : ${detail}` : ''}`))
      })
      xhr.addEventListener('error', () => {
        cleanup()
        reject(new Error(`POST ${url} : erreur réseau pendant l’envoi.`))
      })
      xhr.addEventListener('abort', () => {
        cleanup()
        reject(new DOMException('Import annulé.', 'AbortError'))
      })
      signal?.addEventListener('abort', abortRequest, { once: true })
      xhr.send(form)
    })
    uploaded.push(...result)
    completedBytes += file.size
  }
  return uploaded
}

async function deleteCourseDocument(courseId: number, documentId: string): Promise<void> {
  return requestCourseDocuments<void>(`/courses/${courseId}/documents/${documentId}`, { method: 'DELETE' })
}

async function deleteCourseDocuments(courseId: number): Promise<void> {
  return requestCourseDocuments<void>(`/courses/${courseId}/documents`, { method: 'DELETE' })
}

export const api = {
  chapterItems: loadChapterItems,
  reorderChapterItems,
  createChapterItem,
  deleteChapterItem,
  subjects: loadSubjects,
  reorderSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  getChapters,
  reorderChapters,
  createChapter,
  updateChapter,
  deleteChapter,
  courseFolders: loadCourseFolders,
  createCourseFolder,
  updateCourseFolder,
  deleteCourseFolder,
  courses: loadCourses,
  reorderFolderCourses,
  appendCourseToFolder,
  createCourse,
  updateCourse,
  deleteCourse,
  getPlanningYears,
  createPlanningYear,
  updatePlanningYear,
  deletePlanningYear,
  getPlanningCalendarBlocks,
  createPlanningCalendarBlock,
  updatePlanningCalendarBlock,
  deletePlanningCalendarBlock,
  getPlanningSeries,
  createPlanningSeries,
  updatePlanningSeries,
  deletePlanningSeries,
  getPlanningExceptions,
  upsertPlanningException,
  deletePlanningException,
  askAssistant,
  startRevisionSession,
  getRevisionSessions,
  getRevisionRecommendations,
  getRevisionSession,
  submitRevisionAnswer,
  closeRevisionSession,
      deleteCourseDocuments,
    getCourseDocuments,
    uploadCourseDocuments,
    deleteCourseDocument,
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
