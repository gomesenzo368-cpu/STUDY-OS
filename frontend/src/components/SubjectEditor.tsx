import { useState } from 'react'
import { Check, X } from 'lucide-react'
import { api } from '../api'
import type { Subject } from '../types'
import { normalizeSubjectIcon, subjectIconOptions } from './SubjectIcon'
import { useI18n } from '../i18n/i18n'

type Props = { item?: Subject; onClose: () => void; onSaved: (subject: Subject) => Promise<void>; onError: (message: string) => void }
const colors = [
  { name: 'Noir', value: '#111827' }, { name: 'Gris', value: '#6B7280' }, { name: 'Blanc', value: '#FFFFFF' },
  { name: 'Rouge', value: '#EF4444' }, { name: 'Orange', value: '#F97316' }, { name: 'Jaune', value: '#EAB308' },
  { name: 'Vert', value: '#22C55E' }, { name: 'Cyan', value: '#06B6D4' }, { name: 'Bleu', value: '#3B82F6' },
  { name: 'Violet', value: '#8B5CF6' }, { name: 'Rose', value: '#EC4899' },
]

export default function SubjectEditor({ item, onClose, onSaved, onError }: Props) {
  const { t } = useI18n()
  const [name, setName] = useState(item?.name ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const initialColor = colors.find(option => option.value.toLowerCase() === item?.color?.toLowerCase())?.value ?? '#3B82F6'
  const [color, setColor] = useState(initialColor)
  const [icon, setIcon] = useState(normalizeSubjectIcon(item?.icon))
  const [saving, setSaving] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) { onError(t('errors.save')); return }
    setSaving(true)
    try {
      const body = { name: name.trim(), description: description.trim(), color, icon }
      const savedSubject = item ? await api.updateSubject(item, body) : await api.createSubject(body)
      await onSaved(savedSubject)
    } catch (error) { onError(error instanceof Error ? error.message : 'Impossible d’enregistrer la matière.') } finally { setSaving(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><form className="modal subject-editor-modal" onSubmit={submit}><div className="modal-head"><div><span className="section-kicker">{t('editor.description')}</span><h2>{item ? t('editor.editSubject') : t('editor.newSubject')}</h2></div><button type="button" className="close-button" onClick={onClose} aria-label={t('actions.close')}><X size={18} /></button></div><label>{t('editor.labelName')}<input required autoFocus value={name} onChange={event => setName(event.target.value)} /></label><label>{t('editor.description')}<textarea value={description} onChange={event => setDescription(event.target.value)} rows={3} /></label><div className="subject-options"><fieldset className="color-field"><legend>{t('editor.description')}</legend><div className="color-palette">{colors.map(option => <button key={option.value} type="button" className={`color-swatch ${color === option.value ? 'selected' : ''}`} style={{ backgroundColor: option.value }} onClick={() => setColor(option.value)} aria-label={option.name} aria-pressed={color === option.value} title={option.name}>{color === option.value && <Check size={15} />}</button>)}</div></fieldset><fieldset className="icon-field"><legend>{t('editor.description')}</legend><div className="icon-palette">{subjectIconOptions.map(option => <button key={option.name} type="button" className={`icon-choice ${icon === option.name ? 'selected' : ''}`} onClick={() => setIcon(option.name)} aria-label={t(option.label)} aria-pressed={icon === option.name} title={t(option.label)}><option.Icon size={18} strokeWidth={1.8} /></button>)}</div></fieldset></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('actions.cancel')}</button><button className="primary-button" disabled={saving}>{saving ? t('settings.saving') : item ? t('actions.save') : t('actions.create')}</button></div></form></div>
}
