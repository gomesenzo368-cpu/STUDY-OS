import type { Chapter, Course, LegacyChapter, Subject, Theme } from './types'
import { supabase } from './lib/supabase'

const API_URL = import.meta.env.VITE_API_URL ?? '/api'

type SubjectFields = Pick<Subject, 'name' | 'description' | 'color' | 'icon'>
type ThemeFields = Pick<Theme, 'subject_id' | 'name' | 'description' | 'position'>
type ChapterFields = Pick<Chapter, 'theme_id' | 'name' | 'description' | 'position'>
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

async function loadSubjects(): Promise<Subject[]> {
  await getAuthenticatedUser()
  const { data, error } = await supabase.from('subjects').select('*').order('created_at', { ascending: true })
  if (error) throwSupabaseError('subjects', 'select', error)
  return data as Subject[]
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
  await getAuthenticatedUser()
  const { error } = await supabase.from('subjects').delete().eq('id', id)
  if (error) throwSupabaseError('subjects', 'delete', error)
}

async function getThemes(subjectId?: number): Promise<Theme[]> {
  await getAuthenticatedUser()
  let query = supabase.from('themes').select('*').order('position', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true })
  if (subjectId !== undefined) query = query.eq('subject_id', subjectId)
  const { data, error } = await query
  if (error) throwSupabaseError('themes', 'select', error)
  return data as Theme[]
}

async function createTheme(fields: ThemeFields): Promise<Theme> {
  await getAuthenticatedUser()
  const { data, error } = await supabase.from('themes').insert(fields).select().single()
  if (error) throwSupabaseError('themes', 'insert', error)
  return data as Theme
}

async function updateTheme(theme: Theme, fields: ThemeFields): Promise<Theme> {
  await getAuthenticatedUser()
  const { data, error } = await supabase.from('themes').update({ name: fields.name, description: fields.description, position: fields.position, updated_at: new Date().toISOString() }).eq('id', theme.id).select().single()
  if (error) throwSupabaseError('themes', 'update', error)
  return data as Theme
}

async function deleteTheme(id: number): Promise<void> {
  await getAuthenticatedUser()
  const { error } = await supabase.from('themes').delete().eq('id', id)
  if (error) throwSupabaseError('themes', 'delete', error)
}

async function getChapters(themeId?: number): Promise<Chapter[]> {
  await getAuthenticatedUser()
  let query = supabase.from('chapters').select('*').order('position', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true })
  if (themeId !== undefined) query = query.eq('theme_id', themeId)
  const { data, error } = await query
  if (error) throwSupabaseError('chapters', 'select', error)
  return data as Chapter[]
}

async function createChapter(fields: ChapterFields): Promise<Chapter> {
  await getAuthenticatedUser()
  const { data, error } = await supabase.from('chapters').insert(fields).select().single()
  if (error) throwSupabaseError('chapters', 'insert', error)
  return data as Chapter
}

async function updateChapter(chapter: Chapter, fields: ChapterFields): Promise<Chapter> {
  await getAuthenticatedUser()
  const { data, error } = await supabase.from('chapters').update({ theme_id: fields.theme_id, name: fields.name, description: fields.description, position: fields.position, updated_at: new Date().toISOString() }).eq('id', chapter.id).select().single()
  if (error) throwSupabaseError('chapters', 'update', error)
  return data as Chapter
}

async function deleteChapter(id: number): Promise<void> {
  await getAuthenticatedUser()
  const { error } = await supabase.from('chapters').delete().eq('id', id)
  if (error) throwSupabaseError('chapters', 'delete', error)
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
  subjects: loadSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  getThemes,
  createTheme,
  updateTheme,
  deleteTheme,
  getChapters,
  createChapter,
  updateChapter,
  deleteChapter,
  legacyChaptersForCourses: () => request<LegacyChapter[]>('/chapters'),
  courses: () => request<Course[]>('/courses'),
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
