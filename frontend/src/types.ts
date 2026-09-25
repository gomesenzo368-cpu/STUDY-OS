export type Entity = 'subjects' | 'chapters' | 'course_folders' | 'courses'

export interface Subject { id: number; user_id: string; name: string; description: string | null; color: string | null; icon: string | null; created_at: string; updated_at: string }
export interface Chapter { id: number; user_id: string; subject_id: number; name: string; description: string | null; created_at: string; updated_at: string }
export interface CourseFolder { id: number; user_id: string; chapter_id: number; name: string; created_at: string; updated_at: string }
export interface Course { id: number; user_id: string; chapter_id: number; folder_id: number | null; title: string; content: string; original_content: string; source_type: string; created_at: string; updated_at: string }
export interface ChapterItem { id: number; chapter_id: number; user_id: string; course_id: number | null; folder_id: number | null; position: number; created_at: string; updated_at: string }
export type MixedChapterItem =
	| { type: 'course'; id: number; chapter_item_id: number; position: number; course: Course }
	| { type: 'folder'; id: number; chapter_item_id: number; position: number; folder: CourseFolder }
export type ChapterItemKey = `course:${number}` | `folder:${number}`
export type ChapterItemCreateFields = Pick<ChapterItem, 'chapter_id' | 'course_id' | 'folder_id' | 'position'>
export type ReorderChapterItemPayload = { type: 'course' | 'folder'; id: number }
export interface ReorderChapterItemsPayload { chapter_id: number; items: ReorderChapterItemPayload[] }
export type AnyRecord = Subject | Chapter | CourseFolder | Course
