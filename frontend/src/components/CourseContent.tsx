import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { COURSE_DOCUMENT_ID_ATTRIBUTE, resolveCourseDocument, sanitizeCourseContent } from '../courseDocumentContent'
import type { CourseDocument } from '../types'
import CourseDocumentViewer from './CourseDocumentViewer'

type Props = { courseId: number; content: string; refreshKey?: number }

function makeDocumentFlow(document: CourseDocument, owner: Document): HTMLDivElement {
  const button = owner.createElement('div')
  button.className = 'course-document-content-preview'
  button.setAttribute('role', 'button')
  button.tabIndex = 0
  button.dataset.courseDocumentOpen = document.id
  button.setAttribute('aria-label', `Ouvrir ${document.original_filename}`)
  return button
}

async function renderPdfPages(container: HTMLElement, signedUrl: string, active: () => boolean): Promise<() => void> {
  const [{ GlobalWorkerOptions, getDocument }, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  if (!active()) return () => {}
  GlobalWorkerOptions.workerSrc = worker.default
  const loadingTask = getDocument(signedUrl)
  let pdf: Awaited<typeof loadingTask.promise> | null = null
  let observer: IntersectionObserver | null = null
  let disposed = false
  const renderTasks = new Set<import('pdfjs-dist').RenderTask>()
  const renderedPages = new Set<number>()
  const cleanup = () => {
    if (disposed) return
    disposed = true
    observer?.disconnect()
    renderTasks.forEach((task) => task.cancel())
    renderTasks.clear()
    if (pdf) void pdf.destroy()
    else void loadingTask.destroy()
  }

  try {
    pdf = await loadingTask.promise
    if (!active()) {
      cleanup()
      return cleanup
    }
    const pagesHost = container.ownerDocument.createElement('div')
    pagesHost.className = 'course-document-content-pdf-pages'
    const slots = Array.from({ length: pdf.numPages }, (_, index) => {
      const slot = container.ownerDocument.createElement('div')
      slot.className = 'course-document-content-pdf-page'
      slot.style.aspectRatio = '1 / 1.414'
      slot.setAttribute('aria-label', `Page ${index + 1} du PDF`)
      slot.dataset.pageNumber = String(index + 1)
      const canvas = container.ownerDocument.createElement('canvas')
      canvas.setAttribute('aria-hidden', 'true')
      slot.append(canvas)
      pagesHost.append(slot)
      return { slot, canvas, pageNumber: index + 1 }
    })
    container.append(pagesHost)

    const renderPage = async (pageNumber: number, canvas: HTMLCanvasElement, slot: HTMLElement) => {
      if (!active() || disposed || renderedPages.has(pageNumber) || !pdf) return
      renderedPages.add(pageNumber)
      try {
        const page = await pdf.getPage(pageNumber)
        if (!active() || disposed) return
        const baseViewport = page.getViewport({ scale: 1 })
        slot.style.aspectRatio = `${baseViewport.width} / ${baseViewport.height}`
        const cssWidth = Math.min(860, Math.max(1, slot.clientWidth || container.clientWidth || 780))
        const viewport = page.getViewport({ scale: cssWidth / baseViewport.width })
        const density = Math.min(window.devicePixelRatio || 1, 1.5)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Contexte canvas indisponible.')
        canvas.width = Math.ceil(viewport.width * density)
        canvas.height = Math.ceil(viewport.height * density)
        canvas.style.width = '100%'
        canvas.style.height = 'auto'
        const task = page.render({
          canvasContext: context,
          viewport,
          transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
        })
        renderTasks.add(task)
        await task.promise
        renderTasks.delete(task)
      } catch (cause) {
        if (!disposed && active() && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) {
          slot.dataset.pageError = 'true'
        }
      }
    }

    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          const slot = entry.target as HTMLElement
          const canvas = slot.querySelector('canvas')
          if (canvas) void renderPage(Number(slot.dataset.pageNumber), canvas, slot)
          observer?.unobserve(slot)
        })
      }, { rootMargin: '600px 0px' })
      slots.forEach(({ slot }) => observer?.observe(slot))
    } else {
      await Promise.all(slots.map(({ slot, canvas, pageNumber }) => renderPage(pageNumber, canvas, slot)))
    }
    return cleanup
  } catch (cause) {
    cleanup()
    throw cause
  }
}

async function renderDocxPreview(container: HTMLElement, signedUrl: string, active: () => boolean) {
  const response = await fetch(signedUrl)
  if (!response.ok) throw new Error(`Supabase Storage HTTP ${response.status}`)
  const content = await response.arrayBuffer()
  const { renderAsync } = await import('docx-preview')
  const host = container.ownerDocument.createElement('div')
  host.className = 'course-document-content-docx'
  await renderAsync(content, host, host, { breakPages: true, ignoreLastRenderedPageBreak: false, useBase64URL: true })
  if (!active()) return
  container.append(host)
}

function renderTextPreview(container: HTMLElement, text: string) {
  const preview = container.ownerDocument.createElement('pre')
  preview.className = 'course-document-content-text'
  preview.textContent = text
  container.append(preview)
}

function markDocumentUnavailable(figure: HTMLElement) {
  const message = figure.ownerDocument.createElement('span')
  message.className = 'course-document-content-unavailable'
  message.textContent = 'Document indisponible'
  figure.append(message)
}

export default function CourseContent({ courseId, content, refreshKey = 0 }: Props) {
  const [documents, setDocuments] = useState<CourseDocument[]>([])
  const [error, setError] = useState<string | null>(null)
  const [activeDocument, setActiveDocument] = useState<CourseDocument | null>(null)
  const articleRef = useRef<HTMLElement>(null)
  const sanitizedContent = sanitizeCourseContent(content || '<p></p>')

  useEffect(() => {
    let active = true
    setError(null)
    setDocuments([])
    void api.getCourseDocuments(courseId).then((result) => {
      if (active) setDocuments(result)
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Les documents de ce cours sont indisponibles.')
    })
    return () => { active = false }
  }, [courseId, refreshKey])

  useEffect(() => {
    let active = true
    const cleanups: Array<() => void> = []
    const article = articleRef.current
    if (!article) return () => { active = false }

    const existingFigures = Array.from(article.querySelectorAll<HTMLElement>('figure[data-course-document-id]'))
    if (existingFigures.length === 0) {
      documents.forEach((courseDocument) => {
        const legacyFigure = article.ownerDocument.createElement('figure')
        legacyFigure.setAttribute(COURSE_DOCUMENT_ID_ATTRIBUTE, courseDocument.id)
        article.append(legacyFigure)
      })
    }
    const figures = Array.from(article.querySelectorAll<HTMLElement>('figure[data-course-document-id]'))
    let docxQueue: Promise<void> = Promise.resolve()
    figures.forEach((figure) => {
      const documentId = figure.getAttribute('data-course-document-id')
      const courseDocument = documentId ? resolveCourseDocument(documentId, courseId, documents) : null
      const renderKey = courseDocument
        ? `${courseDocument.id}:${courseDocument.updated_at}:${courseDocument.signed_url ?? ''}:${courseDocument.preview_url ?? ''}`
        : `${documentId ?? ''}:unavailable`
      if (figure.dataset.renderKey === renderKey && figure.childElementCount > 0) return

      figure.replaceChildren()
      figure.className = 'course-document-content-embed'
      figure.dataset.renderKey = renderKey
      if (!courseDocument) {
        const unavailable = article.ownerDocument.createElement('span')
        unavailable.className = 'course-document-content-unavailable'
        unavailable.textContent = 'Document indisponible'
        figure.append(unavailable)
        return
      }

      const preview = makeDocumentFlow(courseDocument, article.ownerDocument)
      figure.append(preview)
      const signedUrl = courseDocument.preview_url ?? courseDocument.signed_url
      if (!signedUrl) {
        markDocumentUnavailable(figure)
        return
      }

      const isCurrent = () => active && figure.isConnected
      const appendCaption = () => {
        if (!isCurrent()) return
        const caption = article.ownerDocument.createElement('figcaption')
        caption.className = 'course-document-content-caption'
        caption.textContent = courseDocument.original_filename
        figure.append(caption)
      }
      if (courseDocument.document_type === 'image') {
        const image = article.ownerDocument.createElement('img')
        image.className = 'course-document-content-image'
        image.src = signedUrl
        image.alt = courseDocument.original_filename
        preview.append(image)
        appendCaption()
      } else if (courseDocument.document_type === 'pdf') {
        void renderPdfPages(preview, signedUrl, isCurrent).then((cleanup) => {
          if (active) cleanups.push(cleanup)
          else cleanup()
          appendCaption()
        }).catch(() => {
          if (isCurrent()) figure.dataset.renderError = 'true'
        })
      } else if (courseDocument.document_type === 'word') {
        docxQueue = docxQueue.then(async () => {
          if (isCurrent()) await renderDocxPreview(preview, signedUrl, isCurrent)
          appendCaption()
        }).catch(() => {
          if (isCurrent()) figure.dataset.renderError = 'true'
        })
      } else {
        void fetch(signedUrl).then((response) => {
          if (!response.ok) throw new Error(`Supabase Storage HTTP ${response.status}`)
          return response.text()
        }).then((text) => {
          if (isCurrent()) renderTextPreview(preview, text)
          appendCaption()
        }).catch(() => {
          if (isCurrent()) figure.dataset.renderError = 'true'
        })
      }
    })

    return () => {
      active = false
      cleanups.forEach((cleanup) => cleanup())
      figures.forEach((figure) => { delete figure.dataset.renderKey })
    }
  }, [courseId, documents, sanitizedContent])

  const openDocument = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return
    const trigger = target.closest<HTMLElement>('[data-course-document-open]')
    const figure = target.closest<HTMLElement>('figure[data-course-document-id]')
    const documentId = trigger?.dataset.courseDocumentOpen ?? figure?.getAttribute('data-course-document-id')
    if (!documentId) return
    const courseDocument = resolveCourseDocument(documentId, courseId, documents)
    if (courseDocument) setActiveDocument(courseDocument)
  }

  return <>
    <article
      ref={articleRef}
      className="course-content"
      dangerouslySetInnerHTML={{ __html: sanitizedContent }}
      onClick={(event) => openDocument(event.target)}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && (event.target.closest('[data-course-document-open]') || event.target.closest('figure[data-course-document-id]'))) {
          event.preventDefault()
          openDocument(event.target)
        }
      }}
    />
    {error && <p className="course-documents-error" role="alert">{error}</p>}
    {activeDocument && <CourseDocumentViewer document={activeDocument} documents={documents} onClose={() => setActiveDocument(null)} />}
  </>
}