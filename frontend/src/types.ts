export type Entity = 'subjects' | 'themes' | 'chapters' | 'courses'

export interface Subject { id: number; user_id: string; name: string; description: string | null; color: string | null; icon: string | null; created_at: string; updated_at: string }
export interface Theme { id: number; subject_id: number; subject_name?: string | null; name: string; description: string | null; position: number | null; created_at: string; updated_at: string }
export interface Chapter { id: number; theme_id: number; name: string; description: string | null; position: number | null; created_at: string; updated_at: string }
export interface LegacyChapter { id: number; theme_id: number; theme_name?: string | null; subject_name?: string | null; name: string; description: string; order: number; created_at: string; updated_at: string }
export interface Course { id: number; chapter_id: number; chapter_name?: string | null; theme_name?: string | null; subject_name?: string | null; title: string; content: string; original_content: string; source_type: string; original_filename: string | null; favorite: boolean; order: number; created_at: string; updated_at: string }
export type AnyRecord = Subject | Theme | Chapter | Course
