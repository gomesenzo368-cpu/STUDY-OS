import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, ArrowRight, FileImage, FileText, Grid2X2, Minus, Plus, X } from 'lucide-react'
import { api } from '../api'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { CourseDocument } from '../types'

type Props = {
  document?: CourseDocument
  documents?: CourseDocument[]
  onClose?: () => void
  inline?: boolean
  listLoading?: boolean
  listError?: string | null
  onDeleteDocument?: (document: CourseDocument) => void
  deletingDocumentId?: string | null
}
type ReaderMode = 'reader' | 'overview'
type SidebarMode = 'documents' | 'pages'
type ReaderState = { page: number; pageCount: number; zoom: number; fitWidth: boolean; mode: ReaderMode }

function initialReaderState(document: CourseDocument): ReaderState {
  return {
    page: 1,
    pageCount: document.document_type === 'image' || document.document_type === 'text' ? 1 : 0,
    zoom: 1,
    fitWidth: false,
    mode: 'reader',
  }
}

function documentTypeLabel(type: CourseDocument['document_type']) {
  return { image: 'Image', pdf: 'PDF', word: 'DOCX', text: 'TXT' }[type]
}

function documentStatusLabel(status: CourseDocument['status']) {
  return { uploaded: 'Importé', processing: 'En traitement', ready: 'Prêt', failed: 'Échec' }[status]
}

function formatDocumentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} o`
  const divisor = bytes < 1024 * 1024 ? 1024 : 1024 * 1024
  const unit = bytes < 1024 * 1024 ? 'Ko' : 'Mo'
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(bytes / divisor)} ${unit}`
}

async function drawPdfCanvas(
  pdf: PDFDocumentProxy,
  canvas: HTMLCanvasElement,
  zoom: number,
  documentId: string,
) {
  const pageNumber = Number(canvas.dataset.pageNumber)
  const thumbnail = canvas.dataset.thumbnail === 'true'
  const target = canvas.parentElement
  if (!pageNumber || !target) return
  const renderKey = `${documentId}:${pageNumber}:${thumbnail ? 'thumbnail' : zoom}`
  if (canvas.dataset.renderKey === renderKey) return
  canvas.dataset.renderKey = renderKey

  try {
    const page = await pdf.getPage(pageNumber)
    if (!canvas.isConnected || canvas.dataset.renderKey !== renderKey) return
    const baseViewport = page.getViewport({ scale: 1 })
    const cssWidth = thumbnail ? 112 : target.clientWidth ? Math.min(1400, target.clientWidth) : baseViewport.width
    const scale = cssWidth / baseViewport.width * (thumbnail || target.clientWidth ? 1 : zoom)
    const viewport = page.getViewport({ scale })
    target.style.aspectRatio = `${baseViewport.width} / ${baseViewport.height}`
    const density = Math.min(window.devicePixelRatio || 1, 1.5)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Contexte canvas indisponible.')
    canvas.width = Math.ceil(viewport.width * density)
    canvas.height = Math.ceil(viewport.height * density)
    canvas.style.width = '100%'
    canvas.style.height = 'auto'
    const task = page.render({
      canvasContext: context as CanvasRenderingContext2D,
      viewport,
      transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
    })
    await task.promise
  } catch (cause) {
    if (canvas.isConnected && canvas.dataset.renderKey === renderKey && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) {
      target.dataset.pageError = 'true'
    }
  }
}

async function fetchStoredFile(url: string): Promise<Response> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Supabase Storage a répondu HTTP ${response.status}.`)
  return response
}

export default function CourseDocumentViewer({ document, documents = document ? [document] : [], onClose = () => {}, inline = false, listLoading = false, listError = null, onDeleteDocument, deletingDocumentId = null }: Props) {
  const availableDocuments = document && !documents.some((item) => item.id === document.id) ? [...documents, document] : documents
  const [selectedDocument, setSelectedDocument] = useState<CourseDocument | null>(document ?? null)
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(document ? 'pages' : 'documents')
  const [documentStates, setDocumentStates] = useState<Record<string, ReaderState>>({})
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)
  const [docxPageText, setDocxPageText] = useState<string[]>([])
  const readerRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLElement>(null)
  const docxHostRef = useRef<HTMLDivElement>(null)
  const pendingNavigationPage = useRef<number | null>(null)
  const state = selectedDocument
    ? documentStates[selectedDocument.id] ?? initialReaderState(selectedDocument)
    : { page: 1, pageCount: 0, zoom: 1, fitWidth: false, mode: 'reader' as ReaderMode }
  const pageCount = state.pageCount
  const page = state.page
  const zoom = state.zoom
  const mode = state.mode

  const updateSelectedState = (patch: Partial<ReaderState>) => {
    if (!selectedDocument) return
    setDocumentStates((current) => ({
      ...current,
      [selectedDocument.id]: { ...initialReaderState(selectedDocument), ...current[selectedDocument.id], ...patch },
    }))
  }

  useEffect(() => {
    if (!inline || !selectedDocument || availableDocuments.some((item) => item.id === selectedDocument.id)) return
    setSelectedDocument(null)
    setSidebarMode('documents')
    setSignedUrl(null)
    setPdfDocument(null)
    setText(null)
    setDocxPageText([])
  }, [inline, selectedDocument?.id, availableDocuments])

  const knownPageCount = (item: CourseDocument) => documentStates[item.id]?.pageCount ?? initialReaderState(item).pageCount
  const selectDocument = (item: CourseDocument) => {
    setSelectedDocument(item)
    setSidebarMode('pages')
    setSignedUrl(null)
    setPdfDocument(null)
    setText(null)
    setDocxPageText([])
    setLoading(true)
    setError(null)
    pendingNavigationPage.current = null
  }

  const backToDocuments = () => {
    setSidebarMode('documents')
    if (inline) {
      setSelectedDocument(null)
      setSignedUrl(null)
      setPdfDocument(null)
      setText(null)
      setDocxPageText([])
      setError(null)
      setLoading(false)
      pendingNavigationPage.current = null
    }
  }

  const goToPage = (nextPage: number) => {
    const next = Math.min(Math.max(pageCount, 1), Math.max(1, nextPage))
    pendingNavigationPage.current = next
    updateSelectedState({ page: next, mode: 'reader' })
  }

  useEffect(() => {
    let active = true
    setSignedUrl(null)
    setPdfDocument(null)
    setText(null)
    setDocxPageText([])
    setError(null)
    setLoading(true)
    if (!selectedDocument) {
      setLoading(false)
      return () => { active = false }
    }
    void api.getCourseDocumentSignedUrl(selectedDocument.course_id, selectedDocument.id).then((url) => {
      if (active) setSignedUrl(url)
    }).catch((cause: unknown) => {
      if (active) {
        setError(cause instanceof Error ? cause.message : 'Impossible de renouveler l’URL Supabase Storage.')
        setLoading(false)
      }
    })
    return () => { active = false }
  }, [selectedDocument?.course_id, selectedDocument?.id])

  useEffect(() => {
    if (inline) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    const previousOverflow = window.document.body.style.overflow
    window.document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.document.body.style.overflow = previousOverflow
    }
  }, [inline, onClose])

  useEffect(() => {
    let active = true
    setText(null)
    setError(null)
    setLoading(true)
    setPdfDocument(null)
    setDocxPageText([])
    docxHostRef.current?.replaceChildren()

    if (!selectedDocument) {
      setLoading(false)
      return () => { active = false }
    }
    docxHostRef.current?.replaceChildren()

    if (selectedDocument.document_type === 'image' || selectedDocument.document_type === 'text') {
      updateSelectedState({ page: 1, pageCount: 1 })
    }

    if (!signedUrl) return

    if (selectedDocument.document_type === 'image') {
      setLoading(false)
      return
    }

    if (selectedDocument.document_type === 'pdf') {
      let destroyLoadingTask: (() => void) | undefined
      void Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]).then(([pdfjs, worker]) => {
        if (!active) return null
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default
        const loadingTask = pdfjs.getDocument(signedUrl)
        destroyLoadingTask = () => { void loadingTask.destroy() }
        return loadingTask.promise
      }).then((pdf) => {
        if (!pdf) return
        if (!active) {
          void pdf.destroy()
          return
        }
        setPdfDocument(pdf)
        updateSelectedState({ pageCount: pdf.numPages, page: Math.min(state.page, pdf.numPages) })
        setLoading(false)
      }).catch((cause: unknown) => {
        if (active) {
          setError(`Lecture PDF depuis Supabase Storage impossible : ${cause instanceof Error ? cause.message : 'erreur inconnue'}`)
          setLoading(false)
        }
      })
      return () => { active = false; destroyLoadingTask?.() }
    }

    if (selectedDocument.document_type === 'text') {
      void fetchStoredFile(signedUrl).then((response) => response.text()).then((content) => {
        if (active) setText(content)
      }).catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Lecture Storage impossible.')
      }).finally(() => { if (active) setLoading(false) })
      return () => { active = false }
    }

    const host = docxHostRef.current
    if (!host) {
      setError('Zone de rendu DOCX indisponible.')
      setLoading(false)
      return
    }
    const renderedHost = host.ownerDocument.createElement('div')
    void fetchStoredFile(signedUrl).then((response) => response.arrayBuffer()).then(async (content) => {
      const { renderAsync } = await import('docx-preview')
      await renderAsync(content, renderedHost, renderedHost, { breakPages: true, ignoreLastRenderedPageBreak: false, useBase64URL: true })
      if (!active) return
      const pages = Array.from(renderedHost.querySelectorAll<HTMLElement>('.docx-wrapper .docx'))
      if (!pages.length) throw new Error('Aucune page DOCX paginée n’a été produite.')
      pages.forEach((item, index) => {
        item.classList.add('course-document-reader-page', 'course-document-reader-docx-page')
        item.dataset.pageNumber = String(index + 1)
        item.setAttribute('aria-label', `Page ${index + 1}`)
        item.tabIndex = 0
      })
      host.replaceChildren(...Array.from(renderedHost.childNodes))
      setDocxPageText(pages.map((item) => item.textContent?.trim().slice(0, 120) ?? ''))
      updateSelectedState({ pageCount: pages.length, page: Math.min(state.page, pages.length) })
    }).catch((cause: unknown) => {
      if (active) setError(`Rendu DOCX impossible : ${cause instanceof Error ? cause.message : 'erreur inconnue'}`)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [selectedDocument?.document_type, selectedDocument?.id, signedUrl])

  useEffect(() => {
    if (!inline || !selectedDocument || documents.some((item) => item.id === selectedDocument.id)) return
    backToDocuments()
  }, [inline, documents, selectedDocument?.id])

  useEffect(() => {
    if (!selectedDocument || !pdfDocument || !readerRef.current) return
    let cancelled = false
    const render = (canvas: HTMLCanvasElement) => {
      if (!cancelled) void drawPdfCanvas(pdfDocument, canvas, zoom, selectedDocument.id)
    }
    const canvases = Array.from(readerRef.current.querySelectorAll<HTMLCanvasElement>('[data-pdf-reader-canvas]'))
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => { if (entry.isIntersecting) render(entry.target as HTMLCanvasElement) })
      }, { rootMargin: '420px 0px', threshold: 0.01 })
      canvases.forEach((canvas) => observer.observe(canvas))
      return () => { cancelled = true; observer.disconnect() }
    }
    canvases.forEach((canvas) => {
      const isThumbnail = canvas.dataset.thumbnail === 'true'
      const canvasPage = Number(canvas.dataset.pageNumber)
      if ((!isThumbnail && canvasPage === page) || (isThumbnail && canvasPage <= 6)) render(canvas)
    })
    return () => { cancelled = true }
  }, [pdfDocument, selectedDocument?.id, pageCount, page, zoom, mode])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const pages = Array.from(stage.querySelectorAll<HTMLElement>('.course-document-reader-page[data-page-number]'))
    if (!selectedDocument || !pages.length || mode !== 'reader' || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver((entries) => {
      const mostVisible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((first, second) => second.intersectionRatio - first.intersectionRatio)[0]
      if (!mostVisible || mostVisible.intersectionRatio < 0.35) return
      const nextPage = Number((mostVisible.target as HTMLElement).dataset.pageNumber)
      if (nextPage) updateSelectedState({ page: nextPage })
    }, { root: stage, threshold: [0.35, 0.6, 0.85] })
    pages.forEach((item) => observer.observe(item))
    return () => observer.disconnect()
  }, [selectedDocument?.id, pageCount, mode])

  useEffect(() => {
    const activeThumb = sidebarRef.current?.querySelector<HTMLElement>(`[data-sidebar-page="${page}"]`)
    activeThumb?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    if (mode !== 'reader' || pendingNavigationPage.current !== page) return
    stageRef.current?.querySelector<HTMLElement>(`.course-document-reader-page[data-page-number="${page}"]`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start', inline: 'nearest' })
    pendingNavigationPage.current = null
  }, [selectedDocument?.id, page, mode])

  const changeZoom = (next: number) => updateSelectedState({ zoom: Math.min(2.5, Math.max(0.5, next)), fitWidth: false })
  const fitToWidth = () => updateSelectedState({ zoom: 1, fitWidth: true })
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1)
  const sidebarPageCount = selectedDocument ? knownPageCount(selectedDocument) : 0
  const typeIcon = (type: CourseDocument['document_type']) => type === 'image' ? <FileImage size={17} /> : <FileText size={17} />

  const renderPdfCanvas = (pageNumber: number, thumbnail: boolean) => (
    <canvas
      aria-hidden="true"
      data-pdf-reader-canvas="true"
      data-page-number={pageNumber}
      data-thumbnail={thumbnail ? 'true' : 'false'}
    />
  )

  const renderPageContent = (pageNumber: number, thumbnail: boolean) => {
    if (!selectedDocument) return null
    if (selectedDocument.document_type === 'pdf') return renderPdfCanvas(pageNumber, thumbnail)
    if (selectedDocument.document_type === 'image' && signedUrl) {
      return <img src={signedUrl} alt={thumbnail ? '' : selectedDocument.original_filename} style={{ width: '100%' }} />
    }
    if (selectedDocument.document_type === 'text') {
      if (thumbnail) return <span className="course-document-reader-page-excerpt">{text?.trim().slice(0, 120) || 'TXT'}</span>
      const value = text ?? ''
      return <pre className="course-document-viewer-text" style={{ fontSize: `${15 * zoom}px` }}>{value}</pre>
    }
    if (selectedDocument.document_type === 'word') {
      return <span className="course-document-reader-page-excerpt">{docxPageText[pageNumber - 1] || `Page ${pageNumber}`}</span>
    }
    return null
  }

  const renderSidebarPage = (pageNumber: number) => (
    <button
      key={pageNumber}
      className={`course-document-page-thumb${page === pageNumber ? ' is-active' : ''}`}
      type="button"
      data-sidebar-page={pageNumber}
      aria-label={`Aller à la page ${pageNumber}`}
      aria-current={page === pageNumber ? 'page' : undefined}
      onClick={() => goToPage(pageNumber)}
    >
      <span className="course-document-page-thumb-preview" data-reader-page-card="true" data-page-number={pageNumber}>
        {renderPageContent(pageNumber, true)}
      </span>
      <span className="course-document-page-thumb-number">Page {pageNumber}</span>
    </button>
  )

  return (
    <div
      className={`course-document-viewer${inline ? ' is-embedded' : ''}`}
      role={inline ? undefined : 'dialog'}
      aria-modal={inline ? undefined : true}
      aria-label={!inline && selectedDocument ? `Visionneuse : ${selectedDocument.original_filename}` : undefined}
      onMouseDown={(event) => { if (!inline && event.target === event.currentTarget) onClose() }}
    >
      <div className="course-document-reader-layout" ref={readerRef}>
        <aside className="course-document-reader-sidebar" ref={sidebarRef}>
          {sidebarMode === 'documents' ? <>
            <div className="course-document-reader-sidebar-heading">Documents</div>
            <div className="course-document-reader-document-list" aria-label="Documents du cours">
              {listLoading && <p className="course-document-reader-list-notice">Chargement des documents…</p>}
              {listError && <p className="course-document-reader-list-error" role="alert">{listError}</p>}
              {!listLoading && !availableDocuments.length && !listError && <p className="course-document-reader-list-notice">Aucun document importé pour ce cours.</p>}
              {availableDocuments.map((item) => {
                const itemPageCount = knownPageCount(item)
                return <div className="course-document-reader-document-row" key={item.id}>
                  <button
                    type="button"
                    className={`course-document-reader-document${item.id === selectedDocument?.id ? ' is-active' : ''}`}
                    aria-label={`Ouvrir ${item.original_filename}`}
                    aria-current={item.id === selectedDocument?.id ? 'true' : undefined}
                    onClick={() => selectDocument(item)}
                  >
                    <span className="course-document-reader-document-icon">{typeIcon(item.document_type)}</span>
                    <span className="course-document-reader-document-copy">
                      <strong title={item.original_filename}>{item.original_filename}</strong>
                      <small>{documentTypeLabel(item.document_type)}{itemPageCount ? ` · ${itemPageCount} page${itemPageCount > 1 ? 's' : ''}` : ''} · {formatDocumentSize(item.file_size)} · {item.position + 1} · {documentStatusLabel(item.status)}</small>
                    </span>
                  </button>
                  {onDeleteDocument && <button
                    className="course-document-reader-delete"
                    type="button"
                    title="Supprimer le document"
                    aria-label={`Supprimer ${item.original_filename}`}
                    disabled={deletingDocumentId === item.id}
                    onClick={() => onDeleteDocument(item)}
                  ><X size={15} /></button>}
                </div>
              })}
            </div>
          </> : <>
            <button className="course-document-reader-back" type="button" aria-label="← DOCUMENTS" onClick={backToDocuments}>
              <ArrowLeft size={15} /> DOCUMENTS
            </button>
            <div className="course-document-reader-current-document">
              <strong title={selectedDocument?.original_filename}>{selectedDocument?.original_filename}</strong>
              {selectedDocument && <span>{documentTypeLabel(selectedDocument.document_type)}{sidebarPageCount ? ` · ${sidebarPageCount} page${sidebarPageCount > 1 ? 's' : ''}` : ''}</span>}
            </div>
            <div className="course-document-reader-page-list" aria-label={`Pages de ${selectedDocument?.original_filename ?? 'ce document'}`}>
              {pages.map(renderSidebarPage)}
            </div>
          </>}
        </aside>

        <section className="course-document-reader-main">
          <header className="course-document-viewer-toolbar">
            <strong className="course-document-viewer-title" title={selectedDocument?.original_filename}>{selectedDocument?.original_filename ?? 'Documents du cours'}</strong>
            <div className="course-document-viewer-controls">
              {selectedDocument && <>
              <button type="button" aria-label="Page précédente" onClick={() => goToPage(page - 1)} disabled={page <= 1}><ArrowLeft size={15} /></button>
              <label className="course-document-page-indicator">Page <input aria-label="Page actuelle" type="number" min={1} max={pageCount || undefined} value={page} onChange={(event) => goToPage(Number(event.currentTarget.value) || 1)} /> / {pageCount || '…'}</label>
              <button type="button" aria-label="Page suivante" onClick={() => goToPage(page + 1)} disabled={!pageCount || page >= pageCount}><ArrowRight size={15} /></button>
              <span className="course-document-reader-control-divider" />
              <button type="button" aria-label="Diminuer le zoom" onClick={() => changeZoom(zoom - 0.25)} disabled={zoom <= 0.5}><Minus size={15} /></button>
              <span className="course-document-zoom-value">{Math.round(zoom * 100)}%</span>
              <button type="button" aria-label="Augmenter le zoom" onClick={() => changeZoom(zoom + 0.25)} disabled={zoom >= 2.5}><Plus size={15} /></button>
              <button type="button" className={state.fitWidth ? 'is-active' : ''} aria-label="Adapter à la largeur" aria-pressed={state.fitWidth} title="Adapter à la largeur" onClick={fitToWidth}>Adapter à la largeur
              </button>
              <button type="button" className={mode === 'overview' ? 'is-active' : ''} aria-label="Vue globale" onClick={() => updateSelectedState({ mode: mode === 'overview' ? 'reader' : 'overview' })}>
                <Grid2X2 size={15} /> Vue globale
              </button>
              {!inline && <button className="course-document-viewer-close" type="button" aria-label="Fermer la visionneuse" onClick={onClose}><X size={18} /></button>}
              </>}
            </div>
          </header>
          <main
            className={`course-document-viewer-stage course-document-reader-stage${mode === 'overview' ? ' is-overview' : ''}${state.fitWidth ? ' is-fit-width' : ''}`}
            ref={stageRef}
            style={{ '--reader-zoom': zoom } as CSSProperties}
            onClick={(event) => {
              if (!(event.target instanceof Element)) return
              const targetPage = event.target.closest<HTMLElement>('.course-document-reader-page[data-page-number]')
              if (targetPage && mode === 'overview') goToPage(Number(targetPage.dataset.pageNumber))
            }}
          >
            {!selectedDocument && !listLoading && !listError && <div className="course-document-reader-empty">
              <FileText size={25} />
              <strong>{availableDocuments.length ? 'Sélectionne un document' : 'Aucun document importé pour ce cours'}</strong>
              {availableDocuments.length > 0 && <span>Les pages et commandes du lecteur apparaîtront ici.</span>}
            </div>}
            {loading && <p className="course-document-viewer-loading" role="status">Chargement du document…</p>}
            {error && <p className="course-document-viewer-error" role="alert">{error}</p>}
            {!loading && !error && selectedDocument?.document_type === 'pdf' && pdfDocument && <div className="course-document-reader-pages">
              {pages.map((pageNumber) => <button
                key={pageNumber}
                type="button"
                className={`course-document-reader-page${page === pageNumber ? ' is-active' : ''}`}
                data-reader-page-card="true"
                data-page-number={pageNumber}
                aria-label={`Page ${pageNumber}`}
                onClick={() => updateSelectedState({ page: pageNumber })}
              >
                {renderPdfCanvas(pageNumber, false)}
                <span className="course-document-reader-page-number">Page {pageNumber}</span>
              </button>)}
            </div>}
            {!loading && !error && selectedDocument?.document_type === 'image' && signedUrl && <div className="course-document-reader-pages">
              <div className="course-document-reader-page" data-page-number="1" style={{ '--reader-zoom': zoom } as CSSProperties}>
                <img className="course-document-viewer-image" src={signedUrl} alt={selectedDocument?.original_filename} style={{ width: '100%' }} />
                <span className="course-document-reader-page-number">Page 1</span>
              </div>
            </div>}
            {!loading && !error && selectedDocument?.document_type === 'text' && text !== null && <div className="course-document-reader-pages">
              <div className="course-document-reader-page" data-page-number="1" style={{ '--reader-zoom': zoom } as CSSProperties}>
                <pre className="course-document-viewer-text" style={{ fontSize: `${15 * zoom}px` }}>{text}</pre>
                <span className="course-document-reader-page-number">Page 1</span>
              </div>
            </div>}
            {selectedDocument?.document_type === 'word' && <div className="course-document-reader-pages">
              <div className="course-document-docx-host course-document-docx-host-reader" ref={docxHostRef} />
            </div>}
          </main>
        </section>
      </div>
    </div>
  )
}