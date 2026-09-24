import {
  Badge,
  BookOpen,
  BriefcaseBusiness,
  Calculator,
  ChartNoAxesCombined,
  FlaskConical,
  Globe2,
  Landmark,
  Languages,
  Laptop,
  Megaphone,
  Medal,
  PenLine,
  ReceiptText,
  Scale,
  Store,
  Users,
  WalletCards,
  type LucideProps,
} from 'lucide-react'

type SubjectIconProps = Omit<LucideProps, 'name'> & { name?: string | null }

export const subjectIconOptions = [
  { name: 'briefcase', label: 'icons.management', Icon: BriefcaseBusiness }, { name: 'chart', label: 'icons.economy', Icon: ChartNoAxesCombined }, { name: 'scale', label: 'icons.law', Icon: Scale }, { name: 'calculator', label: 'icons.math', Icon: Calculator }, { name: 'pen', label: 'icons.french', Icon: PenLine }, { name: 'languages', label: 'icons.english', Icon: Languages }, { name: 'globe', label: 'icons.spanish', Icon: Globe2 }, { name: 'landmark', label: 'icons.history', Icon: Landmark }, { name: 'store', label: 'icons.geography', Icon: Store }, { name: 'laptop', label: 'icons.computing', Icon: Laptop }, { name: 'flask', label: 'icons.science', Icon: FlaskConical }, { name: 'megaphone', label: 'icons.communication', Icon: Megaphone }, { name: 'wallet', label: 'icons.finance', Icon: WalletCards }, { name: 'badge', label: 'icons.hr', Icon: Badge }, { name: 'receipt', label: 'icons.marketing', Icon: ReceiptText }, { name: 'users', label: 'icons.commerce', Icon: Users }, { name: 'building', label: 'icons.business', Icon: BriefcaseBusiness }, { name: 'brain', label: 'icons.revision', Icon: ChartNoAxesCombined }, { name: 'book', label: 'icons.book', Icon: BookOpen }, { name: 'medal', label: 'icons.degree', Icon: Medal },
] as const

const legacyIconNames: Record<string, string> = {
  '📘': 'book', '∑': 'calculator', '◒': 'chart', '⌘': 'briefcase',
  'Aa': 'pen', '♧': 'globe', '⚗': 'flask', '✦': 'medal',
}

export function normalizeSubjectIcon(name?: string | null) {
  return legacyIconNames[name ?? ''] ?? name ?? 'book'
}

export default function SubjectIcon({ name, ...props }: SubjectIconProps) {
  const option = subjectIconOptions.find(item => item.name === normalizeSubjectIcon(name)) ?? subjectIconOptions.find(item => item.name === 'book')!
  return <option.Icon aria-hidden="true" {...props} />
}