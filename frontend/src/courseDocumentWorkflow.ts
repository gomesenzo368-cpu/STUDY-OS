export type CourseDocumentWorkflowProgress = {
  percent: number
  phase: 'transferring' | 'saving' | 'saved'
  fileIndex: number
  fileCount: number
  filename: string
}

export class CourseDocumentWorkflowError<TCourse, TDocument> extends Error {
  readonly course: TCourse
  readonly uploadedDocuments: TDocument[]
  readonly remainingFiles: File[]
  readonly failedFile: File
  readonly cancelled: boolean
  readonly cause: unknown

  constructor(
    course: TCourse,
    uploadedDocuments: TDocument[],
    remainingFiles: File[],
    failedFile: File,
    cause: unknown,
  ) {
    const cancelled = cause instanceof DOMException && cause.name === 'AbortError'
    super(cancelled ? 'Import annulé.' : cause instanceof Error ? cause.message : 'Import documentaire impossible.')
    this.name = 'CourseDocumentWorkflowError'
    this.course = course
    this.uploadedDocuments = uploadedDocuments
    this.remainingFiles = remainingFiles
    this.failedFile = failedFile
    this.cancelled = cancelled
    this.cause = cause
  }
}

export function removeCancelledUpload<T>(files: readonly T[], cancelledFile: T): T[] {
  return files.filter((file) => file !== cancelledFile)
}

type CreateCourseWithDocumentsOptions<TCourse extends { id: number }, TDocument> = {
  createCourse: () => Promise<TCourse>
  files: readonly File[]
  uploadFile: (
    courseId: number,
    file: File,
    signal: AbortSignal | undefined,
    onProgress: (progress: CourseDocumentWorkflowProgress) => void,
  ) => Promise<TDocument[]>
  signal?: AbortSignal
  onProgress?: (progress: CourseDocumentWorkflowProgress) => void
  onDocumentUploaded?: (file: File, documents: TDocument[]) => void
}

export async function createCourseWithDocuments<TCourse extends { id: number }, TDocument>(
  options: CreateCourseWithDocumentsOptions<TCourse, TDocument>,
): Promise<{ course: TCourse; documents: TDocument[] }> {
  const course = await options.createCourse()
  const documents: TDocument[] = []
  const totalBytes = options.files.reduce((total, file) => total + file.size, 0)
  let completedBytes = 0

  for (const [index, file] of options.files.entries()) {
    try {
      if (options.signal?.aborted) throw new DOMException('Import annulé.', 'AbortError')
      const uploaded = await options.uploadFile(
        course.id,
        file,
        options.signal,
        (progress) => options.onProgress?.({
          ...progress,
          percent: totalBytes
            ? progress.phase === 'saved'
              ? Math.min(100, Math.round((completedBytes + file.size) / totalBytes * 100))
              : Math.min(99, Math.round((completedBytes + file.size * progress.percent / 100) / totalBytes * 100))
            : 0,
          fileIndex: index + 1,
          fileCount: options.files.length,
          filename: file.name,
        }),
      )
      documents.push(...uploaded)
      completedBytes += file.size
      options.onDocumentUploaded?.(file, uploaded)
    } catch (cause) {
      throw new CourseDocumentWorkflowError(
        course,
        documents,
        options.files.slice(index),
        file,
        cause,
      )
    }
  }

  return { course, documents }
}
