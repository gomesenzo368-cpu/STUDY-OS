import DOMPurify from 'dompurify'
import type { CourseDocument } from './types'

export const COURSE_DOCUMENT_ID_ATTRIBUTE = 'data-course-document-id'

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

export function isCourseDocumentId(value: string | null): value is string {
  return value !== null && UUID_PATTERN.test(value)
}

export function resolveCourseDocument(
  documentId: string,
  courseId: number,
  documents: readonly CourseDocument[],
): CourseDocument | null {
  return documents.find((document) => document.id === documentId && document.course_id === courseId) ?? null
}

export function sanitizeCourseContent(html: string): string {
  const cleanHtml = DOMPurify.sanitize(html, {
    ADD_ATTR: [COURSE_DOCUMENT_ID_ATTRIBUTE],
    USE_PROFILES: { html: true },
  })
  const parsed = new DOMParser().parseFromString(cleanHtml, 'text/html')

  parsed.body.querySelectorAll(`[${COURSE_DOCUMENT_ID_ATTRIBUTE}]`).forEach((element) => {
    if (element.tagName !== 'FIGURE') {
      element.removeAttribute(COURSE_DOCUMENT_ID_ATTRIBUTE)
      element.removeAttribute('src')
      element.removeAttribute('srcset')
      return
    }

    const documentId = element.getAttribute(COURSE_DOCUMENT_ID_ATTRIBUTE)
    Array.from(element.attributes).forEach((attribute) => {
      if (attribute.name !== COURSE_DOCUMENT_ID_ATTRIBUTE) element.removeAttribute(attribute.name)
    })
    if (isCourseDocumentId(documentId)) element.setAttribute(COURSE_DOCUMENT_ID_ATTRIBUTE, documentId)
    else element.removeAttribute(COURSE_DOCUMENT_ID_ATTRIBUTE)
    element.setAttribute('contenteditable', 'false')
    element.replaceChildren()
  })

  return parsed.body.innerHTML
}

export function serializeCourseContent(editor: HTMLElement): string {
  const clone = editor.cloneNode(true) as HTMLElement
  clone.querySelectorAll(`[${COURSE_DOCUMENT_ID_ATTRIBUTE}]`).forEach((element) => {
    if (element.tagName !== 'FIGURE') {
      element.removeAttribute(COURSE_DOCUMENT_ID_ATTRIBUTE)
      element.removeAttribute('src')
      element.removeAttribute('srcset')
      return
    }

    const documentId = element.getAttribute(COURSE_DOCUMENT_ID_ATTRIBUTE)
    Array.from(element.attributes).forEach((attribute) => {
      if (attribute.name !== COURSE_DOCUMENT_ID_ATTRIBUTE) element.removeAttribute(attribute.name)
    })
    if (isCourseDocumentId(documentId)) element.setAttribute(COURSE_DOCUMENT_ID_ATTRIBUTE, documentId)
    else element.removeAttribute(COURSE_DOCUMENT_ID_ATTRIBUTE)
    element.setAttribute('contenteditable', 'false')
    element.replaceChildren()
  })
  return clone.innerHTML
}

export function insertCourseDocumentFigure(
  editor: HTMLElement,
  savedRange: Range | null,
  documentId: string,
): HTMLElement {
  if (!isCourseDocumentId(documentId)) throw new Error('Identifiant de document invalide.')

  const ownerDocument = editor.ownerDocument
  const range = savedRange?.cloneRange() ?? ownerDocument.createRange()
  if (!savedRange || !editor.contains(range.commonAncestorContainer)) {
    range.selectNodeContents(editor)
    range.collapse(false)
  } else if (!range.collapsed) {
    range.collapse(false)
  }

  const marker = ownerDocument.createElement('span')
  marker.setAttribute('data-course-document-insertion-point', '')
  range.insertNode(marker)

  const figure = ownerDocument.createElement('figure')
  figure.setAttribute(COURSE_DOCUMENT_ID_ATTRIBUTE, documentId)
  figure.setAttribute('contenteditable', 'false')

  const block = marker.parentElement?.closest('p,h1,h2,h3,h4,h5,h6,blockquote,pre')
  if (block && block !== editor && block.parentNode) {
    const beforeRange = ownerDocument.createRange()
    beforeRange.selectNodeContents(block)
    beforeRange.setEndBefore(marker)
    const beforeContent = beforeRange.extractContents()

    const afterRange = ownerDocument.createRange()
    afterRange.selectNodeContents(block)
    afterRange.setStartAfter(marker)
    const afterContent = afterRange.extractContents()
    marker.remove()

    const parent = block.parentNode
    if (beforeContent.hasChildNodes()) {
      const beforeBlock = block.cloneNode(false) as HTMLElement
      beforeBlock.append(beforeContent)
      parent.insertBefore(beforeBlock, block)
    }
    parent.insertBefore(figure, block)

    const afterBlock = block.cloneNode(false) as HTMLElement
    afterBlock.append(afterContent)
    if (!afterBlock.hasChildNodes()) afterBlock.append(ownerDocument.createElement('br'))
    parent.insertBefore(afterBlock, block)
    block.remove()

    const caret = ownerDocument.createRange()
    caret.setStart(afterBlock, 0)
    caret.collapse(true)
    ownerDocument.getSelection()?.removeAllRanges()
    ownerDocument.getSelection()?.addRange(caret)
    return figure
  }

  marker.replaceWith(figure)
  const caret = ownerDocument.createRange()
  caret.setStartAfter(figure)
  caret.collapse(true)
  ownerDocument.getSelection()?.removeAllRanges()
  ownerDocument.getSelection()?.addRange(caret)
  return figure
}