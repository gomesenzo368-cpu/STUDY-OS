import { useEffect, useRef, useState } from 'react'
import { FileImage, FileText, Trash2, Upload, X } from 'lucide-react'
import { api } from '../api'
import type { CourseDocumentUploadProgress } from '../api'
import { removeCancelledUpload } from '../courseDocumentWorkflow'
import type { CourseDocument } from '../types'
import './courseDocuments.css'

type PendingDocument = { key: string; file: File; previewUrl: string | null }
type UploadState = 'idle' | 'uploading' | 'complete' | 'failed' | 'cancelled'

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_BATCH_BYTES = 50 * 1024 * 1024
const MAX_FILES = 10
const ACCEPTED_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

function fileExtension(file: File) {
  return file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} o`
  const unit = bytes < 1024 * 1024 ? 'Ko' : 'Mo'
  const divisor = unit === 'Ko' ? 1024 : 1024 * 1024
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(bytes / divisor)} ${unit}`
}

function statusLabel(status: CourseDocument['status']) {
  return {
    uploaded: 'Importé',
    processing: 'En traitement',
    ready: 'Prêt',
    failed: 'Échec',
  }[status]
}

export default function CourseDocuments({ courseId }: { courseId: number }) {
  const [documents, setDocuments] = useState<CourseDocument[]>([])
  const [pending, setPending] = useState<PendingDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [uploadProgress, setUploadProgress] = useState<CourseDocumentUploadProgress | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const previewUrls = useRef(new Set<string>())
  const uploadController = useRef<AbortController | null>(null)
  const activeUploadKey = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void api.getCourseDocuments(courseId)
      .then((result) => { if (active) setDocuments(result) })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'GET /api/courses/documents : erreur inconnue.')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [courseId])

  useEffect(() => () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  const releasePendingPreviews = () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url))
    previewUrls.current.clear()
  }

  const addFiles = (fileList: FileList | null) => {
    if (!fileList?.length) return
    const incoming = Array.from(fileList)
    const nextFiles = [...pending.map((item) => item.file), ...incoming]
    if (nextFiles.length > MAX_FILES) {
      setError('10 fichiers maximum par import.')
      return
    }
    if (nextFiles.some((file) => file.size <= 0 || file.size > MAX_FILE_BYTES)) {
      setError('Chaque fichier doit peser entre 1 octet et 20 Mo.')
      return
    }
    if (nextFiles.reduce((total, file) => total + file.size, 0) > MAX_BATCH_BYTES) {
      setError('Un import groupé ne peut pas dépasser 50 Mo.')
      return
    }
    const unsupported = incoming.find((file) => ACCEPTED_TYPES[fileExtension(file)] !== file.type)
    if (unsupported) {
      setError(`Format ou type MIME non accepté : ${unsupported.name}`)
      return
    }

    setError(null)
    const additions = incoming.map((file) => {
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
      if (previewUrl) previewUrls.current.add(previewUrl)
      return { key: crypto.randomUUID(), file, previewUrl }
    })
    setPending((current) => [...current, ...additions])
  }

  const removePending = (key: string) => {
    const item = pending.find((candidate) => candidate.key === key)
    if (item?.previewUrl) {
      URL.revokeObjectURL(item.previewUrl)
      previewUrls.current.delete(item.previewUrl)
    }
    setPending((current) => current.filter((candidate) => candidate.key !== key))
  }

  const clearPending = () => {
    releasePendingPreviews()
    setPending([])
    setError(null)
    setUploadProgress(null)
    setUploadState('idle')
    if (inputRef.current) inputRef.current.value = ''
  }

  const upload = async () => {
    if (!pending.length || uploading) return
    setUploading(true)
    setUploadState('uploading')
    setError(null)
    setUploadProgress(null)
    const controller = new AbortController()
    uploadController.current = controller
    const totalBytes = pending.reduce((total, item) => total + item.file.size, 0)
    let completedBytes = 0
    const completedKeys = new Set<string>()
    try {
      for (const [index, item] of pending.entries()) {
        activeUploadKey.current = item.key
        const uploaded = await api.uploadCourseDocuments(
          courseId,
          [item.file],
          (progress) => setUploadProgress({
            ...progress,
            percent: progress.phase === 'saved'
              ? Math.min(100, Math.round((completedBytes + item.file.size) / totalBytes * 100))
              : Math.min(99, Math.round((completedBytes + item.file.size * progress.percent / 100) / totalBytes * 100)),
            fileIndex: index + 1,
            fileCount: pending.length,
          }),
          controller.signal,
        )
        setDocuments((current) => [...current.filter((document) => !uploaded.some((next) => next.id === document.id)), ...uploaded].sort((first, second) => first.position - second.position))
        completedBytes += item.file.size
        completedKeys.add(item.key)
        removePending(item.key)
        activeUploadKey.current = null
      }
      setUploadState('complete')
      try {
        setDocuments(await api.getCourseDocuments(courseId))
      } catch (cause) {
        setError(cause instanceof Error ? `Documents importés, mais actualisation impossible : ${cause.message}` : 'Documents importés, mais la liste n’a pas pu être actualisée.')
      }
      if (inputRef.current) inputRef.current.value = ''
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        const cancelledKey = activeUploadKey.current
        const cancelledItem = pending.find((item) => item.key === cancelledKey)
        if (cancelledItem?.previewUrl) {
          URL.revokeObjectURL(cancelledItem.previewUrl)
          previewUrls.current.delete(cancelledItem.previewUrl)
        }
        const queued = pending.filter((item) => !completedKeys.has(item.key))
        const remaining = cancelledItem ? removeCancelledUpload(queued, cancelledItem) : queued
        setPending(remaining)
        if (remaining.length) setUploadState('cancelled')
        else {
          setUploadState('idle')
          setUploadProgress(null)
        }
      } else {
        setUploadState('failed')
        setError(cause instanceof Error ? cause.message : 'Import documentaire impossible.')
      }
    } finally {
      uploadController.current = null
      activeUploadKey.current = null
      setUploading(false)
    }
  }

  const cancelUpload = () => uploadController.current?.abort()

  const removeDocument = async (document: CourseDocument) => {
    if (!window.confirm(`Supprimer « ${document.original_filename} » et son fichier original ?`)) return
    setDeletingId(document.id)
    setError(null)
    try {
      await api.deleteCourseDocument(courseId, document.id)
      setDocuments((current) => current.filter((item) => item.id !== document.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Impossible de supprimer ce document.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section className="course-documents" aria-labelledby="course-documents-title">
      <div className="course-documents-heading">
        <div>
          <span className="section-kicker">SOURCES</span>
          <h2 id="course-documents-title">Documents du cours</h2>
        </div>
        <button className="small-button" type="button" onClick={() => inputRef.current?.click()} disabled={uploading}>
          <Upload size={15} /> Importer
        </button>
        <input
          ref={inputRef}
          className="course-documents-input"
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.webp,.pdf,.txt,.docx"
          onChange={(event) => {
            addFiles(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />
      </div>

      {pending.length > 0 && (
        <div className="course-document-pending" aria-label="Fichiers en attente d’import">
          <div className="course-document-list-heading">
            <strong>{pending.length} fichier{pending.length > 1 ? 's' : ''} sélectionné{pending.length > 1 ? 's' : ''}</strong>
            <button className="text-button" type="button" onClick={clearPending} disabled={uploading}>Tout retirer</button>
          </div>
          <ul className="course-document-list">
            {pending.map(({ key, file, previewUrl }) => (
              <li className="course-document-row is-pending" key={key}>
                <span className="course-document-preview">
                  {previewUrl ? <img src={previewUrl} alt="" /> : file.type === 'application/pdf' ? <FileText size={21} /> : <FileImage size={21} />}
                </span>
                <span className="course-document-info">
                  <strong title={file.name}>{file.name}</strong>
                  <small>{formatFileSize(file.size)}</small>
                </span>
                <button className="icon-button" type="button" title="Retirer" aria-label={`Retirer ${file.name}`} onClick={() => removePending(key)} disabled={uploading}>
                  <X size={17} />
                </button>
              </li>
            ))}
          </ul>
          {uploadProgress && <div className="course-document-progress">
            <progress value={uploadProgress.percent} max={100} aria-label="Progression du transfert" />
            <span>{uploadProgress.percent}% · {uploadProgress.phase === 'saved' ? `${uploadProgress.filename} enregistré` : uploadProgress.phase === 'saving' ? `Enregistrement de ${uploadProgress.filename}…` : `Transfert ${uploadProgress.fileIndex}/${uploadProgress.fileCount}`}</span>
          </div>}
          {uploadState === 'complete' && <p className="course-document-result is-success">Import terminé.</p>}
          {uploadState === 'cancelled' && <p className="course-document-result">Import annulé. Les documents déjà enregistrés sont conservés.</p>}
          {uploadState === 'failed' && <p className="course-document-result is-failed">Import interrompu. Les documents déjà enregistrés sont conservés.</p>}
          <div className="course-document-actions">
            <button className="secondary-button" type="button" onClick={uploading ? cancelUpload : clearPending}>{uploading ? 'Annuler l’envoi' : 'Annuler'}</button>
            <button className="primary-button" type="button" onClick={() => void upload()} disabled={uploading || pending.length === 0}>
              <Upload size={15} /> {uploading ? 'Envoi en cours...' : 'Envoyer les fichiers'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="course-documents-error" role="alert">{error}</p>}
      {uploadState === 'complete' && pending.length === 0 && <p className="course-document-result is-success">Import terminé.</p>}
      {uploadState === 'cancelled' && pending.length === 0 && <p className="course-document-result">Import annulé. Les documents déjà enregistrés sont conservés.</p>}
      {loading ? (
        <p className="course-documents-empty">Chargement des documents...</p>
      ) : documents.length ? (
        <ol className="course-document-list" aria-label="Documents associés au cours">
          {documents.map((document) => (
            <li className="course-document-row" key={document.id}>
              <span className="course-document-preview">
                  {document.preview_url ? <img src={document.preview_url} alt="" title={document.preview_error ?? undefined} /> : document.document_type === 'image' ? <FileImage size={21} /> : <FileText size={21} />}
              </span>
              <span className="course-document-info">
                <strong title={document.original_filename}>{document.original_filename}</strong>
                  <small title={document.preview_error ?? undefined}>{formatFileSize(document.file_size)} · {document.position + 1}{document.preview_error ? ' · Aperçu indisponible' : ''}</small>
              </span>
              <span className={`course-document-status status-${document.status}`}>{statusLabel(document.status)}</span>
              <button
                className="icon-button course-document-delete"
                type="button"
                title="Supprimer le document"
                aria-label={`Supprimer ${document.original_filename}`}
                onClick={() => void removeDocument(document)}
                disabled={deletingId === document.id}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ol>
      ) : !pending.length ? (
        <p className="course-documents-empty">Aucun document importé pour ce cours.</p>
      ) : null}
    </section>
  )
}