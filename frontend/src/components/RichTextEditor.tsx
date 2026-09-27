import { useEffect, useRef, useState } from 'react'
import { Bold, FilePlus2, Italic, Link, List, ListOrdered, Minus, Quote, Redo2, Undo2 } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import CourseDocumentViewer from './CourseDocumentViewer'
import type { CourseDocument } from '../types'
import { insertCourseDocumentFigure, resolveCourseDocument, sanitizeCourseContent, serializeCourseContent } from '../courseDocumentContent'

type Props = {
  value: string
  onChange: (value: string) => void
  onImport?: (file: File) => Promise<void>
  courseId?: number
  documents?: CourseDocument[]
  onInsertDocument?: (file: File) => Promise<CourseDocument>
}

export default function RichTextEditor({ value, onChange, onImport, courseId, documents = [], onInsertDocument }: Props) {
  const { t } = useI18n()
  const editorRef = useRef<HTMLDivElement>(null)
  const insertInputRef = useRef<HTMLInputElement>(null)
  const insertionRangeRef = useRef<Range | null>(null)
  const [inserting, setInserting] = useState(false)
  const [insertError, setInsertError] = useState<string | null>(null)
  const [activeDocument, setActiveDocument] = useState<CourseDocument | null>(null)
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (serializeCourseContent(editor) !== value) editor.innerHTML = sanitizeCourseContent(value)
    hydrateDocumentFigures(editor, courseId, documents)
  }, [value, courseId, documents])

  const saveSelection = () => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    if (editor.contains(range.commonAncestorContainer)) insertionRangeRef.current = range.cloneRange()
  }

  const emitContent = () => {
    if (editorRef.current) onChange(serializeCourseContent(editorRef.current))
  }

  const insertExistingDocument = (documentId: string) => {
    if (!courseId) return
    const courseDocument = resolveCourseDocument(documentId, courseId, documents)
    const editor = editorRef.current
    if (!courseDocument || !editor) return
    editor.focus()
    insertCourseDocumentFigure(editor, insertionRangeRef.current, courseDocument.id)
    insertionRangeRef.current = null
    emitContent()
  }

  const insertUploadedDocument = async (file: File) => {
    if (!onInsertDocument || inserting) return
    setInserting(true)
    setInsertError(null)
    try {
      const uploadedDocument = await onInsertDocument(file)
      if (courseId && uploadedDocument.course_id !== courseId) throw new Error('Le document n’appartient pas au cours courant.')
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      insertCourseDocumentFigure(editor, insertionRangeRef.current, uploadedDocument.id)
      insertionRangeRef.current = null
      emitContent()
    } catch (cause) {
      setInsertError(cause instanceof Error ? cause.message : 'Insertion du document impossible.')
    } finally {
      setInserting(false)
      if (insertInputRef.current) insertInputRef.current.value = ''
    }
  }

  const handleEmbedClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (inserting) {
      event.preventDefault()
      return
    }
    const target = event.target instanceof Element ? event.target : null
    const removeButton = target?.closest<HTMLElement>('[data-course-document-remove]')
    if (removeButton) {
      event.preventDefault()
      removeButton.closest('figure')?.remove()
      emitContent()
      editorRef.current?.focus()
      return
    }
    const openButton = target?.closest<HTMLElement>('[data-course-document-open]')
    const documentId = openButton?.dataset.courseDocumentOpen
    if (documentId && courseId) {
      const courseDocument = resolveCourseDocument(documentId, courseId, documents)
      if (courseDocument) setActiveDocument(courseDocument)
    }
  }

  const run = (command: string, commandValue?: string) => { editorRef.current?.focus(); document.execCommand(command, false, commandValue); emitContent() }
  const addLink = () => { const url = window.prompt(t('rich.linkPrompt')); if (url) run('createLink', url) }
  const addHeading = (event: React.ChangeEvent<HTMLSelectElement>) => { run('formatBlock', event.target.value); event.target.value = 'p' }
  const commands = [
    { label: t('rich.bold'), icon: Bold, command: 'bold' }, { label: t('rich.italic'), icon: Italic, command: 'italic' },
    { label: t('rich.bullets'), icon: List, command: 'insertUnorderedList' }, { label: t('rich.numbered'), icon: ListOrdered, command: 'insertOrderedList' },
    { label: t('rich.quote'), icon: Quote, command: 'formatBlock', value: 'blockquote' }, { label: t('rich.separator'), icon: Minus, command: 'insertHorizontalRule' },
  ]
  return <div className="rich-editor">
    <div className="editor-toolbar" role="toolbar" aria-label={t('rich.format')}>
      <select aria-label={t('rich.textStyle')} defaultValue="p" disabled={inserting} onChange={addHeading}><option value="p">{t('rich.text')}</option><option value="h2">{t('rich.heading')}</option><option value="h3">{t('rich.subheading')}</option></select>
      {commands.map(({ label, icon: Icon, command, value: commandValue }) => <button type="button" key={label} title={label} aria-label={label} disabled={inserting} onMouseDown={event => event.preventDefault()} onClick={() => run(command, commandValue)}><Icon size={16} /></button>)}
      <button type="button" title={t('rich.link')} aria-label={t('rich.link')} disabled={inserting} onMouseDown={event => event.preventDefault()} onClick={addLink}><Link size={16} /></button>
      <span className="editor-divider" />
      <button type="button" title={t('rich.undo')} aria-label={t('rich.undo')} disabled={inserting} onClick={() => run('undo')}><Undo2 size={16} /></button><button type="button" title={t('rich.redo')} aria-label={t('rich.redo')} disabled={inserting} onClick={() => run('redo')}><Redo2 size={16} /></button>
      {onImport && <label className="editor-import" aria-disabled={inserting}>{t('actions.import')}<input type="file" accept=".txt,.pdf,.docx" disabled={inserting} onChange={event => { const file = event.target.files?.[0]; if (file) void onImport(file); event.currentTarget.value = '' }} /></label>}
      {courseId && documents.length > 0 && <select aria-label="Insérer un document existant" defaultValue="" disabled={inserting} onMouseDown={saveSelection} onChange={event => { insertExistingDocument(event.currentTarget.value); event.currentTarget.value = '' }}>
        <option value="">Insérer un document existant…</option>
        {documents.filter(document => document.course_id === courseId).map(document => <option key={document.id} value={document.id}>{document.original_filename}</option>)}
      </select>}
      {onInsertDocument && <>
        <button type="button" className="editor-import" aria-label="Insérer un fichier original" title="Insérer un fichier original" disabled={inserting} onMouseDown={event => { saveSelection(); event.preventDefault() }} onClick={() => insertInputRef.current?.click()}>
          <FilePlus2 size={15} /> {inserting ? 'Envoi…' : 'Insérer un fichier'}
        </button>
        <input ref={insertInputRef} className="course-documents-input" type="file" aria-label="Fichier original à insérer" accept=".jpg,.jpeg,.png,.webp,.pdf,.txt,.docx" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void insertUploadedDocument(file) }} />
      </>}
      {insertError && <span className="course-document-inline-error" role="alert">{insertError}</span>}
    </div>
    <div ref={editorRef} className={`editor-surface${inserting ? ' is-inserting-document' : ''}`} contentEditable={!inserting} aria-disabled={inserting} role="textbox" aria-multiline="true" data-placeholder={t('rich.write')} onMouseUp={saveSelection} onKeyUp={saveSelection} onClick={handleEmbedClick} onInput={emitContent} onBlur={emitContent} suppressContentEditableWarning />
    {activeDocument && <CourseDocumentViewer document={activeDocument} documents={documents} onClose={() => setActiveDocument(null)} />}
  </div>
}

function hydrateDocumentFigures(editor: HTMLElement, courseId: number | undefined, documents: CourseDocument[]) {
  editor.querySelectorAll<HTMLElement>('figure[data-course-document-id]').forEach(figure => {
    const documentId = figure.getAttribute('data-course-document-id')
    const courseDocument = courseId && documentId ? resolveCourseDocument(documentId, courseId, documents) : null
    const previewUrl = courseDocument?.preview_url ?? courseDocument?.signed_url ?? ''
    const renderKey = `${documentId ?? ''}:${courseDocument?.updated_at ?? ''}:${previewUrl}`
    if (figure.dataset.renderKey === renderKey && figure.childElementCount > 0) return
    figure.replaceChildren()
    figure.setAttribute('contenteditable', 'false')
    figure.className = 'course-document-embed'
    figure.dataset.renderKey = renderKey

    if (!courseDocument) {
      const unavailable = document.createElement('span')
      unavailable.className = 'course-document-embed-unavailable'
      unavailable.textContent = 'Document indisponible'
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'course-document-embed-remove'
      remove.dataset.courseDocumentRemove = documentId ?? ''
      remove.setAttribute('aria-label', 'Retirer la référence indisponible du contenu')
      remove.title = 'Retirer la référence du contenu'
      remove.textContent = '×'
      figure.append(unavailable, remove)
      return
    }

    const preview = document.createElement('button')
    preview.type = 'button'
    preview.className = 'course-document-embed-preview'
    preview.dataset.courseDocumentOpen = courseDocument.id
    preview.setAttribute('aria-label', `Ouvrir ${courseDocument.original_filename}`)
    if (courseDocument.document_type === 'image' && previewUrl) {
      const image = document.createElement('img')
      image.src = previewUrl
      image.alt = courseDocument.original_filename
      preview.append(image)
    } else {
      const kind = document.createElement('span')
      kind.className = 'course-document-embed-kind'
      kind.textContent = courseDocument.document_type.toUpperCase()
      const filename = document.createElement('span')
      filename.className = 'course-document-embed-name'
      filename.textContent = courseDocument.original_filename
      preview.append(kind, filename)
    }
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'course-document-embed-remove'
    remove.dataset.courseDocumentRemove = courseDocument.id
    remove.setAttribute('aria-label', `Retirer ${courseDocument.original_filename} du contenu`)
    remove.title = 'Retirer du contenu (le fichier original est conservé)'
    remove.textContent = '×'
    figure.append(preview, remove)
  })
}
