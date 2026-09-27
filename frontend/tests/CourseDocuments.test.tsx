import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState } from 'react'
import CourseDocuments, { type CourseDocumentsHandle } from '../src/components/CourseDocuments'
import CourseContent from '../src/components/CourseContent'
import RichTextEditor from '../src/components/RichTextEditor'
import type { Course, CourseDocument, CourseFolder } from '../src/types'
import { insertCourseDocumentFigure, resolveCourseDocument, sanitizeCourseContent, serializeCourseContent } from '../src/courseDocumentContent'
import { CourseDetail } from '../src/App'

const { apiMock, pdfMock, pdfPageMock, renderPageMock, supabaseMock } = vi.hoisted(() => {
  const renderPageMock = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
  const pdfPageMock = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale })),
    render: renderPageMock,
  }
  const pdfMock = {
    numPages: 3,
    getPage: vi.fn(async () => pdfPageMock),
    destroy: vi.fn(),
  }
  const apiMock = {
    getCourseDocuments: vi.fn(),
    getCourseDocumentSignedUrl: vi.fn(),
    uploadCourseDocuments: vi.fn(),
    deleteCourseDocument: vi.fn(),
    moveCourse: vi.fn(),
  }
  const supabaseMock = {
    rpc: vi.fn(),
    auth: { getUser: vi.fn() },
    from: vi.fn(),
  }
  return { apiMock, pdfMock, pdfPageMock, renderPageMock, supabaseMock }
})

vi.mock('../src/api', () => ({ api: apiMock }))
vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock }))
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({ promise: Promise.resolve(pdfMock), destroy: vi.fn() })),
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/mock-pdf-worker.mjs' }))
vi.mock('docx-preview', () => ({
  renderAsync: vi.fn(async (data: ArrayBuffer, body: HTMLElement) => {
    const pages = data.byteLength === 16
      ? ['Second file page 1', 'Second file page 2', 'Second file page 3']
      : ['DOCX page 1', 'DOCX page 2']
    body.innerHTML = `<div class="docx-wrapper">${pages.map((page) => `<section class="docx">${page}</section>`).join('')}</div>`
  }),
}))

const makeDocument = (documentType: CourseDocument['document_type'], filename: string): CourseDocument => ({
  id: `${documentType}-1`,
  user_id: 'owner-1',
  course_id: 11,
  original_filename: filename,
  storage_path: `owner-1/11/${documentType}-1/original`,
  mime_type: 'application/octet-stream',
  file_size: 128,
  file_hash: '0'.repeat(64),
  document_type: documentType,
  position: 0,
  status: 'uploaded',
  created_at: '2026-09-26T12:00:00Z',
  updated_at: '2026-09-26T12:00:00Z',
  signed_url: `https://storage.test/${filename}?token=signed`,
  preview_url: documentType === 'image' ? `https://storage.test/${filename}?token=signed` : null,
})

const makeCourse = (folderId: number | null): Course => ({
  id: 17,
  user_id: 'owner-1',
  chapter_id: 11,
  folder_id: folderId,
  folder_position: folderId === null ? null : 0,
  title: 'Cours de suites',
  content: '<p>Contenu à conserver</p>',
  original_content: '<p>Contenu à conserver</p>',
  source_type: 'manual',
  created_at: '2026-09-26T12:00:00Z',
  updated_at: '2026-09-26T12:00:00Z',
})

const makeFolder = (id: number, name: string): CourseFolder => ({
  id,
  user_id: 'owner-1',
  chapter_id: 11,
  name,
  created_at: '2026-09-26T12:00:00Z',
  updated_at: '2026-09-26T12:00:00Z',
})

async function openDocument(document: CourseDocument, documents = [document]) {
  const user = userEvent.setup()
  apiMock.getCourseDocuments.mockResolvedValue(documents)
  const view = render(<CourseDocuments courseId={document.course_id} />)
  await user.click(await screen.findByRole('button', { name: `Ouvrir ${document.original_filename}` }))
  return { user, ...view }
}

function ControlledDocumentEditor({
  initialValue,
  onPersist,
  onInsertDocument,
  courseId,
  documents,
}: {
  initialValue: string
  onPersist: (value: string) => void
  onInsertDocument?: (file: File) => Promise<CourseDocument>
  courseId?: number
  documents?: CourseDocument[]
}) {
  const [value, setValue] = useState(initialValue)
  return <RichTextEditor value={value} onChange={(next) => { setValue(next); onPersist(next) }} onInsertDocument={onInsertDocument} courseId={courseId} documents={documents} />
}

beforeEach(() => {
  vi.clearAllMocks()
  pdfMock.numPages = 3
  apiMock.getCourseDocuments.mockResolvedValue([])
  apiMock.getCourseDocumentSignedUrl.mockImplementation(async (_courseId: number, documentId: string) => `https://storage.test/${documentId}?token=renewed`)
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({}),
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Course document viewer', () => {
  it('lets the course action toolbar open the existing import picker', () => {
    const ref = createRef<CourseDocumentsHandle>()
    const { container } = render(<CourseDocuments ref={ref} courseId={11} />)
    const input = container.querySelector<HTMLInputElement>('.course-documents-input')
    if (!input) throw new Error('Import input missing')
    const click = vi.spyOn(input, 'click')

    act(() => ref.current?.openImport())

    expect(click).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Importer' })).toBeNull()
  })

  it('shows the empty state when a course has no documents', async () => {
    apiMock.getCourseDocuments.mockResolvedValue([])
    render(<CourseDocuments courseId={11} />)

    expect(await screen.findByText('Aucun document importé pour ce cours.')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens an image as one page and closes the viewer', async () => {
    const { user, container } = await openDocument(makeDocument('image', 'photo.webp'))

    expect(container.querySelector('.course-document-viewer.is-embedded')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Adapter à la largeur' }).textContent?.trim()).toBe('Adapter à la largeur')
    const image = await screen.findByRole('img', { name: 'photo.webp' })
    expect(image.getAttribute('src')).toContain('token=renewed')
    expect(apiMock.getCourseDocumentSignedUrl).toHaveBeenCalledWith(11, 'image-1')
    expect(screen.getByLabelText('Page actuelle').getAttribute('max')).toBe('1')
    await user.click(screen.getByRole('button', { name: 'Augmenter le zoom' }))
    expect(screen.getByText('125%')).toBeTruthy()
    expect(document.querySelector('.course-document-reader-stage')?.getAttribute('style')).toContain('--reader-zoom: 1.25')
    await user.click(screen.getByRole('button', { name: '← DOCUMENTS' }))
    expect(within(screen.getByRole('complementary')).getByRole('button', { name: 'Ouvrir photo.webp' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens a PDF with its real page count and supports next, previous, direct page selection and zoom', async () => {
    const { user } = await openDocument(makeDocument('pdf', 'chapter.pdf'))
    const pageInput = await screen.findByLabelText('Page actuelle')
    await waitFor(() => expect(pageInput.getAttribute('max')).toBe('3'))
    expect(pageInput.getAttribute('value')).toBe('1')

    await user.click(screen.getByRole('button', { name: 'Page suivante' }))
    expect(pageInput.getAttribute('value')).toBe('2')
    await user.click(screen.getByRole('button', { name: 'Page précédente' }))
    expect(pageInput.getAttribute('value')).toBe('1')
    fireEvent.change(pageInput, { target: { value: '3' } })
    expect(pageInput.getAttribute('value')).toBe('3')
    await user.click(screen.getByRole('button', { name: 'Augmenter le zoom' }))
    expect(screen.getByText('125%')).toBeTruthy()
    expect(renderPageMock).toHaveBeenCalled()
    expect(pdfPageMock.getViewport).toHaveBeenCalledWith({ scale: 1.25 })

    await user.click(screen.getByRole('button', { name: 'Vue globale' }))
    expect(document.querySelector('.course-document-reader-stage')?.classList.contains('is-overview')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Page 2' }))
    expect(pageInput.getAttribute('value')).toBe('2')
    expect(document.querySelector('.course-document-reader-stage')?.classList.contains('is-overview')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Adapter à la largeur' }))
    expect(screen.getByRole('button', { name: 'Adapter à la largeur' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.course-document-reader-stage')?.classList.contains('is-fit-width')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Vue globale' }))
    expect(document.querySelector('.course-document-reader-stage')?.classList.contains('is-overview')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Page 3' }))
    expect(pageInput.getAttribute('value')).toBe('3')
    expect(document.querySelector('.course-document-reader-stage')?.classList.contains('is-fit-width')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Augmenter le zoom' }))
    expect(screen.getByRole('button', { name: 'Adapter à la largeur' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('opens TXT content directly from the signed Storage URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'Notes du cours\nDeuxième paragraphe' }))
    await openDocument(makeDocument('text', 'notes.txt'))

    await waitFor(() => expect(document.querySelector('.course-document-reader-stage .course-document-viewer-text')?.textContent).toContain('Notes du cours'))
    expect(within(screen.getByRole('complementary')).getByText(/Notes du cours/)).toBeTruthy()
    expect(fetch).toHaveBeenCalledWith('https://storage.test/text-1?token=renewed')
  })

  it('opens DOCX as paginated pages and navigates without treating it as a PDF', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    const { user } = await openDocument(makeDocument('word', 'chapter.docx'))
    const pageInput = await screen.findByLabelText('Page actuelle')
    await waitFor(() => expect(pageInput.getAttribute('max')).toBe('2'))
    const pageOne = document.querySelector<HTMLElement>('.course-document-reader-docx-page[data-page-number="1"]')
    const pageTwo = document.querySelector<HTMLElement>('.course-document-reader-docx-page[data-page-number="2"]')
    expect(pageOne?.textContent).toContain('DOCX page 1')
    expect(pageTwo?.textContent).toContain('DOCX page 2')
    expect(within(screen.getByRole('complementary')).getByText('DOCX page 1')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Page suivante' }))
    expect(pageInput.getAttribute('value')).toBe('2')
    expect(pageOne?.textContent).toContain('DOCX page 1')
    expect(pageTwo?.textContent).toContain('DOCX page 2')
  })

  it('replaces all DOCX pages when switching documents in one viewer', async () => {
    const first = { ...makeDocument('word', 'first.docx'), id: 'docx-first' }
    const second = { ...makeDocument('word', 'second.docx'), id: 'docx-second' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(url.includes('docx-second') ? 16 : 8),
    })))
    const { user } = await openDocument(first, [first, second])
    const pageInput = await screen.findByLabelText('Page actuelle')
    await waitFor(() => expect(pageInput.getAttribute('max')).toBe('2'))

    await user.click(screen.getByRole('button', { name: '← DOCUMENTS' }))
    await user.click(within(screen.getByRole('complementary')).getByRole('button', { name: 'Ouvrir second.docx' }))
    await waitFor(() => expect(screen.getByLabelText('Page actuelle').getAttribute('max')).toBe('3'))

    const renderedPages = document.querySelectorAll('.course-document-reader-docx-page')
    expect(renderedPages).toHaveLength(3)
    expect(document.querySelector('.course-document-reader-stage')?.textContent).toContain('Second file page 1')
    expect(document.querySelector('.course-document-reader-stage')?.textContent).not.toContain('DOCX page 1')
  })

  it('switches documents, preserves each page state and returns from global view to the selected page', async () => {
    const pdf = { ...makeDocument('pdf', 'Cours de maths.pdf'), id: 'pdf-maths' }
    const image = { ...makeDocument('image', 'Photo tableau.jpg'), id: 'image-board' }
    const { user } = await openDocument(pdf, [pdf, image])
    const pageInput = await screen.findByLabelText('Page actuelle')
    await waitFor(() => expect(pageInput.getAttribute('max')).toBe('3'))

    await user.click(screen.getByRole('button', { name: 'Page suivante' }))
    expect(pageInput.getAttribute('value')).toBe('2')
    await user.click(screen.getByRole('button', { name: '← DOCUMENTS' }))
    const sidebar = screen.getByRole('complementary')
    expect(within(sidebar).getByRole('button', { name: 'Ouvrir Photo tableau.jpg' })).toBeTruthy()
    await user.click(within(sidebar).getByRole('button', { name: 'Ouvrir Photo tableau.jpg' }))
    const selectedImage = await screen.findByRole('img', { name: 'Photo tableau.jpg' })
    expect(selectedImage.getAttribute('src')).toContain('image-board?token=renewed')
    const imagePageInput = screen.getByLabelText('Page actuelle')
    expect(imagePageInput.getAttribute('max')).toBe('1')
    await user.click(screen.getByRole('button', { name: 'Augmenter le zoom' }))
    expect(screen.getByText('125%')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '← DOCUMENTS' }))
    await user.click(within(sidebar).getByRole('button', { name: 'Ouvrir Cours de maths.pdf' }))
    await waitFor(() => expect(screen.getByLabelText('Page actuelle').getAttribute('value')).toBe('2'))
    const pdfPageInput = screen.getByLabelText('Page actuelle')
    expect(pdfPageInput.getAttribute('max')).toBe('3')
    expect(screen.getByText('100%')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Vue globale' }))
    await user.click(screen.getByRole('button', { name: 'Page 3' }))
    expect(screen.getByLabelText('Page actuelle').getAttribute('value')).toBe('3')
    expect(document.querySelector('.course-document-reader-stage')?.classList.contains('is-overview')).toBe(false)
  })

  it('returns to the document list when the selected document is deleted', async () => {
    const image = { ...makeDocument('image', 'photo-to-delete.png'), id: 'image-to-delete' }
    apiMock.getCourseDocuments.mockResolvedValue([image])
    apiMock.deleteCourseDocument.mockResolvedValue(undefined)
    vi.stubGlobal('confirm', vi.fn(() => true))
    const { user } = await openDocument(image)

    await user.click(screen.getByRole('button', { name: '← DOCUMENTS' }))
    await user.click(screen.getByRole('button', { name: 'Supprimer photo-to-delete.png' }))

    await waitFor(() => expect(apiMock.deleteCourseDocument).toHaveBeenCalledWith(11, image.id))
    expect(await screen.findByText('Aucun document importé pour ce cours.')).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'photo-to-delete.png' })).toBeNull()
  })

  it('surfaces a Storage failure with its HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }))
    await openDocument(makeDocument('text', 'private.txt'))

    expect((await screen.findByRole('alert')).textContent).toContain('Supabase Storage a répondu HTTP 403')
  })

  it('does not present a failed document request as an empty course', async () => {
    apiMock.getCourseDocuments.mockRejectedValue(new Error('GET /api/courses/11/documents → HTTP 500'))
    render(<CourseDocuments courseId={11} />)

    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 500')
    expect(screen.queryByText('Aucun document importé pour ce cours.')).toBeNull()
  })
})

describe('course move workflow', () => {
  it.each([
    { sourceFolderId: null, destinationFolderId: 41, label: 'a course at chapter root' },
    { sourceFolderId: 40, destinationFolderId: 41, label: 'a course in another folder' },
    { sourceFolderId: 40, destinationFolderId: null, label: 'a course returning to chapter root' },
  ])('opens the single toolbar action and moves $label', async ({ sourceFolderId, destinationFolderId }) => {
    const course = makeCourse(sourceFolderId)
    const destination = makeFolder(41, 'Révisions')
    const libraryDocument = { ...makeDocument('image', 'photo.png'), id: '2f1710e2-596f-4a2c-989e-df3f3d27a113' }
    apiMock.getCourseDocuments.mockResolvedValue([libraryDocument])
    const movedCourse = { ...course, folder_id: destinationFolderId, folder_position: destinationFolderId === null ? null : 2 }
    const onMoved = vi.fn(async () => {})
    const user = userEvent.setup()
    const { container } = render(<CourseDetail
      course={course}
      subjects={[{ id: 2, user_id: 'owner-1', name: 'Maths', description: null, color: null, icon: null, position: 0, created_at: course.created_at, updated_at: course.updated_at }]}
      chapters={[{ id: 11, user_id: 'owner-1', subject_id: 2, name: 'Suites', description: null, position: 0, created_at: course.created_at, updated_at: course.updated_at }]}
      courseFolders={[makeFolder(40, 'Cours'), destination]}
      documentRevision={0}
      onDocumentsChanged={vi.fn()}
      onBack={vi.fn()}
      onStudy={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onMoved={onMoved}
      onRefresh={vi.fn(async () => {})}
    />)

    expect(container.querySelector('.course-document-viewer.is-embedded')).toBeTruthy()
    expect(await within(screen.getByRole('complementary')).findByRole('button', { name: 'Ouvrir photo.png' })).toBeTruthy()
    expect(Array.from(container.querySelectorAll('.detail-actions button'), (button) => button.textContent?.trim())).toEqual([
      'Étudier', 'Modifier', 'Importer', 'Déplacer', 'Supprimer',
    ])
    expect(container.querySelector('.move-panel')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Déplacer' }))
    const dialog = screen.getByRole('dialog', { name: 'Déplacer le cours' })
    const folderSelect = within(dialog).getByRole('combobox', { name: 'Dossier destination' })
    await user.selectOptions(folderSelect, destinationFolderId === null ? '' : String(destinationFolderId))
    apiMock.moveCourse.mockResolvedValue(movedCourse)
    await user.click(within(dialog).getByRole('button', { name: 'Confirmer le déplacement' }))

    await waitFor(() => expect(apiMock.moveCourse).toHaveBeenCalledWith(course, destinationFolderId))
    expect(onMoved).toHaveBeenCalledWith(movedCourse)
  })

  it('uses the existing folder RPC for each supported source/destination case', async () => {
    const actualApi = await vi.importActual<typeof import('../src/api')>('../src/api')
    supabaseMock.rpc.mockResolvedValue({ data: true, error: null })

    const rootCourse = makeCourse(null)
    await actualApi.api.moveCourse(rootCourse, 41)
    expect(supabaseMock.rpc).toHaveBeenLastCalledWith('append_course_to_folder', { p_course_id: rootCourse.id, p_folder_id: 41 })

    const folderCourse = makeCourse(40)
    await actualApi.api.moveCourse(folderCourse, 41)
    expect(supabaseMock.rpc).toHaveBeenLastCalledWith('move_course_to_folder', { p_course_id: folderCourse.id, p_folder_id: 41 })

    await actualApi.api.moveCourse(folderCourse, null)
    expect(supabaseMock.rpc).toHaveBeenLastCalledWith('remove_course_from_folder', { p_course_id: folderCourse.id })
  })
})

describe('course document content references', () => {
  it('passes every course document to the shared viewer opened from an editor marker', async () => {
    const selected = { ...makeDocument('pdf', 'notes.pdf'), id: '2f1710e2-596f-4a2c-989e-df3f3d27a113' }
    const another = { ...makeDocument('image', 'photo.png'), id: 'c37893a2-52e6-41ef-9cd3-21231a6e0da4' }
    const user = userEvent.setup()
    render(<RichTextEditor value={`<figure data-course-document-id="${selected.id}"></figure>`} onChange={vi.fn()} courseId={11} documents={[selected, another]} />)

    await user.click(await screen.findByRole('button', { name: 'Ouvrir notes.pdf' }))
    await user.click(screen.getByRole('button', { name: '← DOCUMENTS' }))

    expect(within(screen.getByRole('complementary')).getByRole('button', { name: /photo\.png/ })).toBeTruthy()
  })

  it('preserves surrounding course HTML and serializes only the stable UUID marker', () => {
    const editor = document.createElement('div')
    const documentId = '2f1710e2-596f-4a2c-989e-df3f3d27a113'
    editor.innerHTML = `<p class="existing">Texte 1</p><figure data-course-document-id="${documentId}" contenteditable="false"><img src="https://temporary.invalid/file" alt="photo"></figure><p>Texte 2</p>`

    const serialized = serializeCourseContent(editor)

    expect(serialized).toContain('<p class="existing">Texte 1</p>')
    expect(serialized.indexOf('Texte 1')).toBeLessThan(serialized.indexOf(documentId))
    expect(serialized.indexOf(documentId)).toBeLessThan(serialized.indexOf('Texte 2'))
    expect(serialized).not.toContain('temporary.invalid')
    expect(serialized).toContain(`<figure data-course-document-id="${documentId}" contenteditable="false"></figure>`)
  })

  it('does not serialize an arbitrary image URL attached to a non-figure document marker', () => {
    const editor = document.createElement('div')
    editor.innerHTML = '<p>Avant</p><img data-course-document-id="2f1710e2-596f-4a2c-989e-df3f3d27a113" src="https://attacker.invalid/image"><p>Après</p>'

    const serialized = serializeCourseContent(editor)

    expect(serialized).not.toContain('data-course-document-id')
    expect(serialized).not.toContain('attacker.invalid')
    expect(serialized.indexOf('Avant')).toBeLessThan(serialized.indexOf('Après'))
  })

  it('keeps only document markers on figures and strips malicious preview URLs', () => {
    const documentId = '2f1710e2-596f-4a2c-989e-df3f3d27a113'
    const safe = sanitizeCourseContent(`<p class="keep">Avant</p><figure data-course-document-id="${documentId}" onclick="alert(1)"><img src="https://attacker.invalid/steal"></figure><img data-course-document-id="${documentId}" src="https://attacker.invalid/marker.png"><span data-course-document-id="${documentId}">Fake</span><p>Après</p>`)

    expect(safe).toContain('<p class="keep">Avant</p>')
    expect(safe.indexOf('Avant')).toBeLessThan(safe.indexOf(documentId))
    expect(safe.indexOf(documentId)).toBeLessThan(safe.indexOf('Après'))
    expect(safe).not.toContain('attacker.invalid')
    expect(safe).not.toContain('onclick')
    expect(safe).not.toContain('<span data-course-document-id')
    expect(safe).toContain(`<figure data-course-document-id="${documentId}" contenteditable="false"></figure>`)
  })

  it('resolves references only against documents belonging to the current course', () => {
    const currentCourseDocument = makeDocument('image', 'current.png')
    const otherCourseDocument = { ...makeDocument('pdf', 'private.pdf'), id: 'other-course-document', course_id: 12 }

    expect(resolveCourseDocument(currentCourseDocument.id, 11, [currentCourseDocument])).toBe(currentCourseDocument)
    expect(resolveCourseDocument(otherCourseDocument.id, 11, [otherCourseDocument])).toBeNull()
    expect(resolveCourseDocument('not-an-uuid', 11, [currentCourseDocument])).toBeNull()
  })

  it('inserts a document at a saved caret between surrounding text', () => {
    const editor = document.createElement('div')
    editor.innerHTML = '<p>Texte avant texte après</p>'
    document.body.append(editor)
    const text = editor.querySelector('p')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 'Texte avant '.length)
    range.collapse(true)
    const documentId = '2f1710e2-596f-4a2c-989e-df3f3d27a113'

    insertCourseDocumentFigure(editor, range, documentId)
    const serialized = serializeCourseContent(editor)

    expect(serialized).toContain('<p>Texte avant </p>')
    expect(serialized.indexOf('Texte avant')).toBeLessThan(serialized.indexOf(documentId))
    expect(serialized.indexOf(documentId)).toBeLessThan(serialized.indexOf('texte après'))
    expect(editor.querySelector('figure')?.getAttribute('contenteditable')).toBe('false')
    editor.remove()
  })

  it('inserts an uploaded file at the saved caret after an asynchronous upload', async () => {
    let completeUpload: ((document: CourseDocument) => void) | undefined
    const onInsertDocument = vi.fn(() => new Promise<CourseDocument>((resolve) => { completeUpload = resolve }))
    const onChange = vi.fn()
    const documentId = '2f1710e2-596f-4a2c-989e-df3f3d27a113'
    const uploadedDocument = { ...makeDocument('image', 'photo.png'), id: documentId }
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    const view = render(<ControlledDocumentEditor initialValue="<p>Avant après</p>" onPersist={onChange} onInsertDocument={onInsertDocument} courseId={11} />)
    const editor = screen.getByRole('textbox')
    await waitFor(() => expect(editor.innerHTML).toContain('Avant après'))
    const text = editor.querySelector('p')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 'Avant '.length)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.mouseUp(editor)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Insérer un fichier original' }))
    fireEvent.change(screen.getByLabelText('Fichier original à insérer'), { target: { files: [file] } })

    await waitFor(() => expect(editor.getAttribute('contenteditable')).toBe('false'))
    expect(onInsertDocument).toHaveBeenCalledWith(file)
    completeUpload?.(uploadedDocument)
    await waitFor(() => expect(editor.innerHTML).toContain(documentId))
    const serialized = onChange.mock.calls.at(-1)?.[0] as string
    expect(serialized.indexOf('Avant')).toBeLessThan(serialized.indexOf(documentId))
    expect(serialized.indexOf(documentId)).toBeLessThan(serialized.indexOf('après'))
    expect(serialized).not.toContain('temporary.invalid')
    view.unmount()
  })

  it('inserts an already imported document at the saved caret without uploading it again', async () => {
    const documentId = '2f1710e2-596f-4a2c-989e-df3f3d27a113'
    const existing = { ...makeDocument('pdf', 'existing.pdf'), id: documentId }
    const onPersist = vi.fn()
    const { view } = { view: render(<ControlledDocumentEditor initialValue="<p>Avant après</p>" onPersist={onPersist} courseId={11} documents={[existing]} />) }
    const editor = screen.getByRole('textbox')
    await waitFor(() => expect(editor.innerHTML).toContain('Avant après'))
    const text = editor.querySelector('p')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 'Avant '.length)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.mouseUp(editor)
    const documentSelect = screen.getByRole('combobox', { name: 'Insérer un document existant' })
    fireEvent.mouseDown(documentSelect)
    fireEvent.change(documentSelect, { target: { value: documentId } })

    await waitFor(() => expect(onPersist.mock.calls.at(-1)?.[0]).toContain(documentId))
    const saved = onPersist.mock.calls.at(-1)?.[0] as string
    expect(saved.indexOf('Avant')).toBeLessThan(saved.indexOf(documentId))
    expect(saved.indexOf(documentId)).toBeLessThan(saved.indexOf('après'))
    expect(apiMock.uploadCourseDocuments).not.toHaveBeenCalled()
    view.unmount()
  })

  it('removes only an embedded reference, never the original document record', async () => {
    const documentId = '2f1710e2-596f-4a2c-989e-df3f3d27a113'
    const courseDocument = { ...makeDocument('pdf', 'notes.pdf'), id: documentId }
    const onChange = vi.fn()
    const view = render(<RichTextEditor value={`<p>Avant</p><figure data-course-document-id="${documentId}" contenteditable="false"></figure><p>Après</p>`} onChange={onChange} courseId={11} documents={[courseDocument]} />)

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Retirer notes.pdf du contenu' }))

    const serialized = onChange.mock.calls.at(-1)?.[0] as string
    expect(serialized).not.toContain(documentId)
    expect(serialized).toContain('Avant')
    expect(serialized).toContain('Après')
    expect(apiMock.deleteCourseDocument).not.toHaveBeenCalled()
    view.unmount()
  })
})

describe('inline course document previews', () => {
  const imageId = '2f1710e2-596f-4a2c-989e-df3f3d27a113'
  const pdfId = 'c37893a2-52e6-41ef-9cd3-21231a6e0da4'
  const docxId = '79673c47-2d5b-4505-8bc0-c9f43b986229'
  const textId = '0b7e9497-9e94-49a0-8f7a-c1226d9da71e'

  it('renders image, PDF, DOCX and TXT previews in HTML order and opens the existing viewer', async () => {
    const documents = [
      { ...makeDocument('image', 'photo.png'), id: imageId },
      { ...makeDocument('pdf', 'handout.pdf'), id: pdfId },
      { ...makeDocument('word', 'chapter.docx'), id: docxId },
      { ...makeDocument('text', 'notes.txt'), id: textId },
    ]
    apiMock.getCourseDocuments.mockResolvedValue(documents)
    const fullText = 'TXT complet avec retour à la ligne\n'.repeat(40)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('notes.txt')
      ? { ok: true, text: async () => fullText }
      : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    const html = `<p>Texte 1</p><figure data-course-document-id="${imageId}"></figure><p>Texte 2</p><figure data-course-document-id="${pdfId}"></figure><figure data-course-document-id="${docxId}"></figure><figure data-course-document-id="${textId}"></figure><p>Texte 3</p>`
    const user = userEvent.setup()
    const { container } = render(<CourseContent courseId={11} content={html} />)

    expect(await screen.findByRole('img', { name: 'photo.png' })).toBeTruthy()
    await waitFor(() => expect(container.querySelector('.course-document-content-text')?.textContent).toBe(fullText))
    await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull())
    expect(container.querySelectorAll('.course-document-content-pdf-page')).toHaveLength(3)
    expect(container.querySelectorAll('.course-document-content-pdf-page canvas')).toHaveLength(3)
    expect(await screen.findByText('DOCX page 1')).toBeTruthy()
    expect(screen.getByText('DOCX page 2').closest('section')?.hidden).toBe(false)
    const renderedText = container.querySelector('article')?.textContent ?? ''
    expect(renderedText.indexOf('Texte 1')).toBeLessThan(renderedText.indexOf('photo.png'))
    expect(renderedText.indexOf('photo.png')).toBeLessThan(renderedText.indexOf('Texte 2'))
    expect(renderedText.indexOf('Texte 2')).toBeLessThan(renderedText.indexOf('handout.pdf'))
    expect(renderedText.indexOf('handout.pdf')).toBeLessThan(renderedText.indexOf('chapter.docx'))
    expect(renderedText.indexOf('chapter.docx')).toBeLessThan(renderedText.indexOf('TXT complet'))
    expect(renderedText.indexOf('TXT complet')).toBeLessThan(renderedText.indexOf('Texte 3'))

    await user.click(screen.getByText('handout.pdf'))
    expect(await screen.findByRole('dialog', { name: 'Visionneuse : handout.pdf' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Fermer la visionneuse' }))
    await user.click(screen.getByRole('img', { name: 'photo.png' }))
    expect(await screen.findByRole('dialog', { name: 'Visionneuse : photo.png' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Fermer la visionneuse' }))
    await user.click(container.querySelector('.course-document-content-text') as HTMLElement)
    expect(await screen.findByRole('dialog', { name: 'Visionneuse : notes.txt' })).toBeTruthy()
  })

  it('renders legacy course documents after existing content when the saved HTML has no markers', async () => {
    const legacyDocuments = [1, 2, 3].map((position) => ({
      ...makeDocument('word', `legacy-${position}.docx`),
      id: `79673c47-2d5b-4505-8bc0-c9f43b98622${position}`,
      position: position - 1,
    }))
    const legacyHtml = '<p>Texte déjà enregistré dans le cours.</p>'
    apiMock.getCourseDocuments.mockResolvedValue(legacyDocuments)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }))
    const { container } = render(<CourseContent courseId={11} content={legacyHtml} />)

    await waitFor(() => expect(screen.getAllByText('DOCX page 1')).toHaveLength(3))
    const article = container.querySelector('article')
    expect(article?.querySelectorAll('figure[data-course-document-id]')).toHaveLength(3)
    expect(article?.textContent?.indexOf('Texte déjà enregistré')).toBeLessThan(article?.textContent?.indexOf('legacy-1.docx'))
    expect(article?.textContent?.indexOf('legacy-1.docx')).toBeLessThan(article?.textContent?.indexOf('legacy-2.docx'))
    expect(article?.textContent?.indexOf('legacy-2.docx')).toBeLessThan(article?.textContent?.indexOf('legacy-3.docx'))
    expect(legacyHtml).not.toContain('data-course-document-id')
    expect(legacyHtml).not.toContain('token=signed')
  })

  it('shows a deleted or cross-course document as unavailable and never loads its embedded URL', async () => {
    const otherCourseDocument = { ...makeDocument('image', 'private.png'), id: imageId, course_id: 12 }
    apiMock.getCourseDocuments.mockResolvedValue([otherCourseDocument])
    const { container } = render(<CourseContent courseId={11} content={`<figure data-course-document-id="${imageId}"><img src="https://attacker.invalid/image"></figure>`} />)

    expect(await screen.findByText('Document indisponible')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    expect(apiMock.getCourseDocumentSignedUrl).not.toHaveBeenCalled()
  })

  it('creates every long-PDF page slot but renders only pages entering the viewport', async () => {
    const observedTargets: Element[] = []
    const observers: Array<{
      callback: IntersectionObserverCallback
      disconnect: ReturnType<typeof vi.fn>
    }> = []
    class MockIntersectionObserver {
      readonly disconnect = vi.fn()
      constructor(readonly callback: IntersectionObserverCallback) { observers.push(this) }
      observe(target: Element) { observedTargets.push(target) }
      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    pdfMock.numPages = 100
    apiMock.getCourseDocuments.mockResolvedValue([{ ...makeDocument('pdf', 'long.pdf'), id: 'c37893a2-52e6-41ef-9cd3-21231a6e0da4' }])
    const html = '<figure data-course-document-id="c37893a2-52e6-41ef-9cd3-21231a6e0da4"></figure>'
    const view = render(<CourseContent courseId={11} content={html} />)

    await waitFor(() => expect(observedTargets).toHaveLength(100))
    expect(view.container.querySelectorAll('.course-document-content-pdf-page')).toHaveLength(100)
    expect(pdfMock.getPage).not.toHaveBeenCalled()
    const page58 = view.container.querySelector('[data-page-number="58"]') as HTMLElement
    observers[0].callback([{ target: page58, isIntersecting: true } as IntersectionObserverEntry], observers[0] as unknown as IntersectionObserver)
    await waitFor(() => expect(pdfMock.getPage).toHaveBeenCalledWith(58))
    view.unmount()
    expect(observers[0].disconnect).toHaveBeenCalled()
  })

  it('keeps a deleted document reference in saved HTML and renders it unavailable after reload', async () => {
    const deletedDocumentId = '2f1710e2-596f-4a2c-989e-df3f3d27a113'
    apiMock.getCourseDocuments.mockResolvedValue([])
    const savedContent = sanitizeCourseContent(`<p>Avant</p><figure data-course-document-id="${deletedDocumentId}"></figure><p>Après</p>`)
    const { container } = render(<CourseContent courseId={11} content={savedContent} />)

    expect(await screen.findByText('Document indisponible')).toBeTruthy()
    expect(container.querySelector(`figure[data-course-document-id="${deletedDocumentId}"]`)).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    expect(apiMock.deleteCourseDocument).not.toHaveBeenCalled()
  })

  it('does not keep a stale preview when refreshing documents fails after deletion', async () => {
    const image = { ...makeDocument('image', 'stale.png'), id: '2f1710e2-596f-4a2c-989e-df3f3d27a113' }
    apiMock.getCourseDocuments.mockResolvedValueOnce([image])
    const html = `<figure data-course-document-id="${image.id}"></figure>`
    const view = render(<CourseContent courseId={11} content={html} refreshKey={0} />)
    expect(await screen.findByRole('img', { name: 'stale.png' })).toBeTruthy()

    apiMock.getCourseDocuments.mockRejectedValueOnce(new Error('GET /documents → HTTP 500'))
    view.rerender(<CourseContent courseId={11} content={html} refreshKey={1} />)

    expect(await screen.findByText('Document indisponible')).toBeTruthy()
    expect(view.container.querySelector('img')).toBeNull()
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 500')
  })

  it('reloads a saved document marker and renders its image from the current course list', async () => {
    const image = { ...makeDocument('image', 'reloaded.png'), id: '2f1710e2-596f-4a2c-989e-df3f3d27a113' }
    apiMock.getCourseDocuments.mockResolvedValue([image])
    const persistedHtml = serializeCourseContent(Object.assign(document.createElement('div'), {
      innerHTML: `<p>Avant</p><figure data-course-document-id="${image.id}" contenteditable="false"><img src="https://temporary.invalid"></figure><p>Après</p>`,
    }))
    const { container } = render(<CourseContent courseId={11} content={persistedHtml} />)

    expect((await screen.findByRole('img', { name: 'reloaded.png' })).getAttribute('src')).toContain('token=signed')
    const text = container.querySelector('article')?.textContent ?? ''
    expect(text.indexOf('Avant')).toBeLessThan(text.indexOf('reloaded.png'))
    expect(text.indexOf('reloaded.png')).toBeLessThan(text.indexOf('Après'))
    expect(persistedHtml).not.toContain('temporary.invalid')
  })
})
