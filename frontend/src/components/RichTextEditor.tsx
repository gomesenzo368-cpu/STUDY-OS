import { useEffect, useRef } from 'react'
import { Bold, Italic, Link, List, ListOrdered, Minus, Quote, Redo2, Undo2 } from 'lucide-react'
import { useI18n } from '../i18n/i18n'

type Props = { value: string; onChange: (value: string) => void; onImport?: (file: File) => Promise<void> }

export default function RichTextEditor({ value, onChange, onImport }: Props) {
  const { t } = useI18n()
  const editorRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (editorRef.current && editorRef.current.innerHTML !== value) editorRef.current.innerHTML = value }, [value])
  const run = (command: string, commandValue?: string) => { editorRef.current?.focus(); document.execCommand(command, false, commandValue); onChange(editorRef.current?.innerHTML ?? '') }
  const addLink = () => { const url = window.prompt(t('rich.linkPrompt')); if (url) run('createLink', url) }
  const addHeading = (event: React.ChangeEvent<HTMLSelectElement>) => { run('formatBlock', event.target.value); event.target.value = 'p' }
  const commands = [
    { label: t('rich.bold'), icon: Bold, command: 'bold' }, { label: t('rich.italic'), icon: Italic, command: 'italic' },
    { label: t('rich.bullets'), icon: List, command: 'insertUnorderedList' }, { label: t('rich.numbered'), icon: ListOrdered, command: 'insertOrderedList' },
    { label: t('rich.quote'), icon: Quote, command: 'formatBlock', value: 'blockquote' }, { label: t('rich.separator'), icon: Minus, command: 'insertHorizontalRule' },
  ]
  return <div className="rich-editor">
    <div className="editor-toolbar" role="toolbar" aria-label={t('rich.format')}>
      <select aria-label={t('rich.textStyle')} defaultValue="p" onChange={addHeading}><option value="p">{t('rich.text')}</option><option value="h2">{t('rich.heading')}</option><option value="h3">{t('rich.subheading')}</option></select>
      {commands.map(({ label, icon: Icon, command, value: commandValue }) => <button type="button" key={label} title={label} aria-label={label} onMouseDown={event => event.preventDefault()} onClick={() => run(command, commandValue)}><Icon size={16} /></button>)}
      <button type="button" title={t('rich.link')} aria-label={t('rich.link')} onMouseDown={event => event.preventDefault()} onClick={addLink}><Link size={16} /></button>
      <span className="editor-divider" />
      <button type="button" title={t('rich.undo')} aria-label={t('rich.undo')} onClick={() => run('undo')}><Undo2 size={16} /></button><button type="button" title={t('rich.redo')} aria-label={t('rich.redo')} onClick={() => run('redo')}><Redo2 size={16} /></button>
      {onImport && <label className="editor-import">{t('actions.import')}<input type="file" accept=".txt,.pdf,.docx" onChange={event => { const file = event.target.files?.[0]; if (file) void onImport(file); event.currentTarget.value = '' }} /></label>}
    </div>
    <div ref={editorRef} className="editor-surface" contentEditable role="textbox" aria-multiline="true" data-placeholder={t('rich.write')} onInput={event => onChange(event.currentTarget.innerHTML)} onBlur={event => onChange(event.currentTarget.innerHTML)} suppressContentEditableWarning />
  </div>
}
