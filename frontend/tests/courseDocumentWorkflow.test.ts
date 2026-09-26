import assert from 'node:assert/strict'
import test from 'node:test'
import { createCourseWithDocuments, CourseDocumentWorkflowError, removeCancelledUpload } from '../src/courseDocumentWorkflow.ts'

const course = { id: 73 }
const makeFile = (name: string, size: number) => new File([new Uint8Array(size)], name)

test('creates a course once without documents', async () => {
  let creates = 0
  let uploads = 0
  const result = await createCourseWithDocuments({
    createCourse: async () => { creates += 1; return course },
    files: [],
    uploadFile: async () => { uploads += 1; return [] },
  })
  assert.equal(creates, 1)
  assert.equal(uploads, 0)
  assert.equal(result.course.id, 73)
  assert.deepEqual(result.documents, [])
})

test('creates a course then uploads one document to its real id', async () => {
  const file = makeFile('page.jpg', 10)
  const uploadCourseIds: number[] = []
  const result = await createCourseWithDocuments({
    createCourse: async () => course,
    files: [file],
    uploadFile: async (courseId, currentFile) => {
      uploadCourseIds.push(courseId)
      assert.equal(currentFile, file)
      return [{ id: 'document-1' }]
    },
  })
  assert.deepEqual(uploadCourseIds, [73])
  assert.deepEqual(result.documents, [{ id: 'document-1' }])
})

test('creates one course and uploads multiple files sequentially', async () => {
  const files = [makeFile('first.png', 10), makeFile('second.pdf', 30)]
  let creates = 0
  const uploaded: string[] = []
  const result = await createCourseWithDocuments({
    createCourse: async () => { creates += 1; return course },
    files,
    uploadFile: async (courseId, file) => {
      assert.equal(courseId, 73)
      uploaded.push(file.name)
      return [{ id: file.name }]
    },
  })
  assert.equal(creates, 1)
  assert.deepEqual(uploaded, ['first.png', 'second.pdf'])
  assert.deepEqual(result.documents, [{ id: 'first.png' }, { id: 'second.pdf' }])
})

test('keeps every imported file associated with the supplied existing course id', async () => {
  let createOrLookupCalls = 0
  const uploadCourseIds: number[] = []
  await createCourseWithDocuments({
    createCourse: async () => { createOrLookupCalls += 1; return course },
    files: [makeFile('existing-course.jpg', 10)],
    uploadFile: async (courseId) => { uploadCourseIds.push(courseId); return [] },
  })
  assert.equal(createOrLookupCalls, 1)
  assert.deepEqual(uploadCourseIds, [73])
})

test('keeps a successfully uploaded file and reports only failed and remaining files', async () => {
  const files = [makeFile('saved.jpg', 10), makeFile('failed.png', 10), makeFile('not-started.pdf', 10)]
  const uploaded: string[] = []
  let calls = 0
  await assert.rejects(
    createCourseWithDocuments({
      createCourse: async () => course,
      files,
      uploadFile: async (_courseId, file) => {
        calls += 1
        if (file.name === 'failed.png') throw new Error('HTTP 502 Storage')
        uploaded.push(file.name)
        return [{ id: file.name }]
      },
      onDocumentUploaded: (file) => uploaded.push(`${file.name}:listed`),
    }),
    (error: unknown) => {
      assert.ok(error instanceof CourseDocumentWorkflowError)
      assert.equal(error.course.id, 73)
      assert.deepEqual(error.uploadedDocuments, [{ id: 'saved.jpg' }])
      assert.deepEqual(error.remainingFiles.map((file) => file.name), ['failed.png', 'not-started.pdf'])
      assert.equal(error.failedFile.name, 'failed.png')
      assert.equal(error.cancelled, false)
      return true
    },
  )
  assert.equal(calls, 2)
  assert.deepEqual(uploaded, ['saved.jpg', 'saved.jpg:listed'])
})

test('cancels an active file and preserves earlier successful documents', async () => {
  const files = [makeFile('saved.jpg', 10), makeFile('active.png', 10), makeFile('not-started.pdf', 10)]
  const controller = new AbortController()
  const uploaded: string[] = []
  await assert.rejects(
    createCourseWithDocuments({
      createCourse: async () => course,
      files,
      signal: controller.signal,
      uploadFile: async (_courseId, file, signal) => {
        if (file.name === 'active.png') {
          controller.abort()
          if (signal?.aborted) throw new DOMException('Import annulé.', 'AbortError')
        }
        uploaded.push(file.name)
        return [{ id: file.name }]
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof CourseDocumentWorkflowError)
      assert.equal(error.cancelled, true)
      assert.deepEqual(error.uploadedDocuments, [{ id: 'saved.jpg' }])
      assert.deepEqual(error.remainingFiles.map((file) => file.name), ['active.png', 'not-started.pdf'])
      return true
    },
  )
  assert.deepEqual(uploaded, ['saved.jpg'])
})

test('removing the last cancelled file closes the pending import queue', () => {
  const onlyFile = makeFile('active.jpg', 10)
  const remaining = removeCancelledUpload([onlyFile], onlyFile)
  assert.deepEqual(remaining, [])
  assert.equal(remaining.length === 0, true)
})

test('cancelling one queued file leaves the other files untouched', () => {
  const earlierSuccess = makeFile('saved.jpg', 10)
  const active = makeFile('active.png', 10)
  const waiting = makeFile('waiting.pdf', 10)
  const remaining = removeCancelledUpload([active, waiting], active)
  assert.deepEqual(remaining, [waiting])
  assert.equal(remaining.includes(earlierSuccess), false)
})

test('reports monotonic progress from transferred bytes and separates server saving', async () => {
  const files = [makeFile('first.jpg', 10), makeFile('second.jpg', 30)]
  const progress: number[] = []
  const phases: string[] = []
  await createCourseWithDocuments({
    createCourse: async () => course,
    files,
    uploadFile: async (_courseId, file, _signal, onProgress) => {
      onProgress({ percent: 50, phase: 'transferring', fileIndex: 0, fileCount: 0, filename: file.name })
      onProgress({ percent: 100, phase: 'saving', fileIndex: 0, fileCount: 0, filename: file.name })
      onProgress({ percent: 100, phase: 'saved', fileIndex: 0, fileCount: 0, filename: file.name })
      return []
    },
    onProgress: (value) => { progress.push(value.percent); phases.push(value.phase) },
  })
  assert.deepEqual(progress, [13, 25, 25, 63, 99, 100])
  assert.deepEqual(phases, ['transferring', 'saving', 'saved', 'transferring', 'saving', 'saved'])
})
