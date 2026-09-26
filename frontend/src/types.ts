export type Entity = 'subjects' | 'chapters' | 'course_folders' | 'courses'

export interface Subject { id: number; user_id: string; name: string; description: string | null; color: string | null; icon: string | null; position: number | null; created_at: string; updated_at: string }
export interface Chapter { id: number; user_id: string; subject_id: number; name: string; description: string | null; position: number | null; created_at: string; updated_at: string }
export interface CourseFolder { id: number; user_id: string; chapter_id: number; name: string; created_at: string; updated_at: string }
export interface Course { id: number; user_id: string; chapter_id: number; folder_id: number | null; folder_position: number | null; title: string; content: string; original_content: string; source_type: string; created_at: string; updated_at: string }
export type CourseDocumentStatus = 'uploaded' | 'processing' | 'ready' | 'failed'
export type CourseDocumentType = 'image' | 'pdf' | 'text' | 'word'
export interface CourseDocument { id: string; user_id: string; course_id: number; original_filename: string; storage_path: string; mime_type: string; file_size: number; file_hash: string; document_type: CourseDocumentType; position: number; status: CourseDocumentStatus; created_at: string; updated_at: string; preview_url: string | null; preview_error?: string | null }
export type RevisionQuestionType = 'multiple_choice' | 'true_false' | 'short_answer'
export type RevisionSessionStatus = 'in_progress' | 'completed' | 'abandoned'
export interface RevisionChoice { id: string; text: string }
export interface RevisionSessionQuestion { question_id: number; question_type: RevisionQuestionType; question_text: string; choices: RevisionChoice[] | null; position: number }
export interface RevisionAnswer { snapshot_question_id?: number; question_id?: number | null; answer: unknown; is_correct: boolean; question_text_snapshot?: string; answered_at?: string }
export interface RevisionSession { id?: number; session_id?: number; course_id: number; status: RevisionSessionStatus; total_questions: number; correct_answers: number; score: number; started_at?: string; questions?: RevisionSessionQuestion[]; answers?: RevisionAnswer[]; snapshot_complete?: boolean }
export interface RevisionAnswerResult { is_correct: boolean; correct_answers: number; total_questions: number; score: number }
export interface RevisionReviewItem { id: number; session_id: number; question_id: number | null; question_text_snapshot: string; question_type_snapshot: RevisionQuestionType; choices_snapshot: RevisionChoice[] | null; answer: unknown; is_correct: boolean; answered_at: string }
export interface ChapterItem { id: number; chapter_id: number; user_id: string; course_id: number | null; folder_id: number | null; position: number; created_at: string; updated_at: string }
export type PlanningRecurrence = 'weekly' | 'once'
export type PlanningWeekPattern = 'all' | 'even' | 'odd'
export type PlanningExceptionStatus = 'cancelled' | 'modified'
export interface PlanningYear { id: number; user_id: string; name: string; starts_on: string; ends_on: string; time_zone: string; created_at: string; updated_at: string }
export interface PlanningCalendarBlock { id: number; user_id: string; year_id: number; kind: 'break' | 'holiday'; name: string | null; starts_on: string; ends_on: string; description: string | null; created_at: string; updated_at: string }
export interface PlanningSeries { id: number; user_id: string; year_id: number; entry_type: string; title: string; subject_id: number | null; teacher: string | null; room: string | null; day_of_week: number; recurrence: PlanningRecurrence; week_pattern: PlanningWeekPattern; starts_on: string; ends_on: string | null; start_time: string; end_time: string; color_key: string | null; icon_key: string | null; status: 'active' | 'cancelled'; created_at: string; updated_at: string }
export type PlanningSeriesOverrides = Partial<Pick<PlanningSeries, 'title' | 'subject_id' | 'teacher' | 'room' | 'start_time' | 'end_time' | 'color_key' | 'icon_key'>>
export interface PlanningException { id: number; user_id: string; series_id: number; occurrence_date: string; status: PlanningExceptionStatus; override_date: string | null; overrides: PlanningSeriesOverrides; created_at: string; updated_at: string }
export interface PlanningOccurrence { series: PlanningSeries; occurrence_date: string; date: string; title: string; teacher: string; room: string; start_time: string; end_time: string; color_key: string; icon_key: string; cancelled: boolean }
export type PlanningYearFields = Pick<PlanningYear, 'name' | 'starts_on' | 'ends_on' | 'time_zone'>
export type PlanningCalendarBlockFields = Pick<PlanningCalendarBlock, 'year_id' | 'kind' | 'name' | 'starts_on' | 'ends_on' | 'description'>
export type PlanningSeriesFields = Pick<PlanningSeries, 'year_id' | 'entry_type' | 'title' | 'subject_id' | 'teacher' | 'room' | 'day_of_week' | 'recurrence' | 'week_pattern' | 'starts_on' | 'ends_on' | 'start_time' | 'end_time' | 'color_key' | 'icon_key' | 'status'>
export type PlanningExceptionFields = Pick<PlanningException, 'series_id' | 'occurrence_date' | 'status' | 'override_date' | 'overrides'>
export type MixedChapterItem =
	| { type: 'course'; id: number; chapter_item_id: number; position: number; course: Course }
	| { type: 'folder'; id: number; chapter_item_id: number; position: number; folder: CourseFolder }
export type ChapterItemKey = `course:${number}` | `folder:${number}`
export type ChapterItemCreateFields = Pick<ChapterItem, 'chapter_id' | 'course_id' | 'folder_id' | 'position'>
export type ReorderChapterItemPayload = { type: 'course' | 'folder'; id: number }
export interface ReorderChapterItemsPayload { chapter_id: number; items: ReorderChapterItemPayload[] }
export type AnyRecord = Subject | Chapter | CourseFolder | Course
