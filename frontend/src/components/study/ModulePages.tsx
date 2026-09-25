import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  FileQuestion,
  GraduationCap,
  MessageCircle,
  Play,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";
import SubjectIcon from "../SubjectIcon";
import type { Chapter, Course, Subject } from "../../types";
export { default as PlanningPage } from "../planning/PlanningPage";

type ModuleCardProps = {
  icon: typeof BrainCircuit;
  title: string;
  description: string;
  onClick?: () => void;
};

function ModuleCard({ icon: Icon, title, description, onClick }: ModuleCardProps) {
  return (
    <button className="module-action-card" onClick={onClick} disabled={!onClick}>
      <span className="module-action-icon"><Icon size={20} /></span>
      <span className="module-action-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <ArrowRight size={17} />
    </button>
  );
}

function EmptyModuleState({ icon: Icon, title, description }: { icon: typeof BrainCircuit; title: string; description: string }) {
  return (
    <div className="module-empty-state">
      <span className="module-empty-icon"><Icon size={24} /></span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function ModuleHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="module-header">
      <span className="eyebrow"><span className="status-dot" /> {eyebrow}</span>
      <h1 className="display-title">{title}</h1>
      <p>{description}</p>
    </div>
  );
}

export function RevisionsPage({
  subjects,
  chapters,
  courses,
  onStudyCourse,
}: {
  subjects: Subject[];
  chapters: Chapter[];
  courses: Course[];
  onStudyCourse: (course: Course) => void;
}) {
  const recentCourses = courses.slice(-3).reverse();

  return (
    <section className="module-page revisions-page">
      <ModuleHeader
        eyebrow="RÉVISIONS"
        title="Qu'est-ce que tu veux réviser aujourd'hui ?"
        description="Transforme tes cours en sessions de travail claires et progressives."
      />
      <div className="module-action-grid">
        <ModuleCard icon={Play} title="Révision rapide" description="Commencer avec un cours" onClick={recentCourses[0] ? () => onStudyCourse(recentCourses[0]) : undefined} />
        <ModuleCard icon={BrainCircuit} title="Mes révisions" description="Retrouver mes sessions" />
        <ModuleCard icon={Sparkles} title="Révisions recommandées" description="Bientôt disponibles" />
      </div>

      <ModuleSection title="Mes matières" description="Choisis une matière pour commencer à consolider tes connaissances.">
        {subjects.length ? (
          <div className="module-subject-grid">
            {subjects.map((subject) => {
              const subjectChapters = chapters.filter((chapter) => chapter.subject_id === subject.id);
              const subjectCourses = courses.filter((course) => subjectChapters.some((chapter) => chapter.id === course.chapter_id));
              return (
                <article className="module-subject-card" key={subject.id}>
                  <span className="module-subject-icon"><SubjectIcon name={subject.icon} size={20} /></span>
                  <strong>{subject.name}</strong>
                  <span>{subjectChapters.length} chapitre{subjectChapters.length === 1 ? "" : "s"} · {subjectCourses.length} cours</span>
                  <button className="text-button" disabled={!subjectCourses.length}>{subjectCourses.length ? "Réviser" : "Aucun cours"} <ArrowRight size={15} /></button>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyModuleState icon={GraduationCap} title="Tes matières apparaîtront ici" description="Ajoute d'abord une matière et un cours pour commencer à réviser." />
        )}
      </ModuleSection>

      <ModuleSection title="Continuer mes révisions" description="Reprends rapidement là où tu t'es arrêté.">
        {recentCourses.length ? (
          <div className="module-course-list">
            {recentCourses.map((course) => (
              <button className="module-course-row" key={course.id} onClick={() => onStudyCourse(course)}>
                <span className="module-row-icon"><FileQuestion size={18} /></span>
                <span><strong>{course.title}</strong><small>Étudier ce cours</small></span>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
        ) : (
          <EmptyModuleState icon={Clock3} title="Aucune session récente" description="Tes cours étudiés apparaîtront ici." />
        )}
      </ModuleSection>

      <ModuleSection title="À revoir" description="Les contenus à consolider seront regroupés ici.">
        <EmptyModuleState icon={Target} title="Pas encore de recommandations" description="Commence une première session pour voir apparaître tes priorités." />
      </ModuleSection>
    </section>
  );
}

export function StudyCoursePage({
  course,
  subject,
  chapter,
  onBack,
}: {
  course: Course;
  subject?: Subject;
  chapter?: Chapter;
  onBack: () => void;
}) {
  const [mode, setMode] = useState("Bilan du cours");
  const modes = [
    { label: "Bilan du cours", icon: FileQuestion },
    { label: "Fiche de révision", icon: ClipboardCheck },
    { label: "Quiz", icon: CheckCircle2 },
    { label: "Questions", icon: MessageCircle },
    { label: "Exercices", icon: Target },
  ];

  return (
    <section className="module-page study-page">
      <button className="back-button" onClick={onBack}><ArrowLeft size={17} /> Retour au cours</button>
      <div className="study-breadcrumbs">{subject?.name ?? "Matière"} <span>/</span> {chapter?.name ?? "Chapitre"} <span>/</span> Cours</div>
      <div className="study-heading">
        <div><span className="course-label">ESPACE D'ÉTUDE</span><h1>{course.title}</h1><p>Choisis un mode pour travailler ce cours à ton rythme.</p></div>
        <span className="study-mark"><GraduationCap size={24} /></span>
      </div>
      <div className="study-mode-grid">
        {modes.map(({ label, icon: Icon }) => (
          <button className={`study-mode-card ${mode === label ? "active" : ""}`} key={label} onClick={() => setMode(label)}>
            <Icon size={19} /><span>{label}</span>
          </button>
        ))}
      </div>
      <div className="study-placeholder">
        <span className="module-empty-icon"><Sparkles size={24} /></span>
        <span className="section-kicker">{mode.toUpperCase()}</span>
        <h2>Cette fonctionnalité sera bientôt disponible.</h2>
        <p>Ton espace d'étude est prêt à accueillir ce mode de révision.</p>
      </div>
    </section>
  );
}

export function ControlsPage() {
  return (
    <section className="module-page">
      <ModuleHeader eyebrow="CONTRÔLES" title="Prépare tes prochains contrôles" description="Centralise les dates importantes et transforme-les en objectifs de révision." />
      <div className="module-toolbar"><span>Mes prochains contrôles</span><button className="secondary-button" disabled><ClipboardCheck size={16} /> Ajouter un contrôle</button></div>
      <EmptyModuleState icon={ClipboardCheck} title="Aucun contrôle prévu" description="Les contrôles que tu ajouteras apparaîtront ici avec leur temps restant et leur niveau de préparation." />
    </section>
  );
}

export function ProgressPage() {
  return (
    <section className="module-page">
      <ModuleHeader eyebrow="PROGRESSION" title="Vois le chemin parcouru" description="Ta progression se construira naturellement au fil de tes révisions." />
      <div className="progress-card-grid">
        {[
          [TrendingUp, "Progression générale"],
          [GraduationCap, "Matières et chapitres"],
          [CheckCircle2, "Révisions effectuées"],
          [Target, "Points à améliorer"],
        ].map(([Icon, label]) => {
          const ProgressIcon = Icon as typeof TrendingUp;
          return <div className="progress-placeholder-card" key={label as string}><ProgressIcon size={20} /><strong>{label as string}</strong><span>En attente de tes premières données</span></div>;
        })}
      </div>
      <EmptyModuleState icon={TrendingUp} title="Ta progression apparaîtra ici" description="Commence à réviser pour voir tes matières, chapitres et résultats prendre forme." />
    </section>
  );
}

export function AssistantPage() {
  return (
    <section className="module-page assistant-page">
      <ModuleHeader eyebrow="ASSISTANT STUDY OS" title="Que veux-tu faire ?" description="Un espace pour comprendre, réviser et organiser ton travail, bientôt à tes côtés." />
      <div className="assistant-prompt-grid">
        <ModuleCard icon={FileQuestion} title="Explique-moi un cours" description="Comprendre une notion" />
        <ModuleCard icon={BrainCircuit} title="Fais-moi réviser" description="Consolider tes connaissances" />
        <ModuleCard icon={CheckCircle2} title="Teste-moi" description="Vérifier ce que tu sais" />
        <ModuleCard icon={ClipboardCheck} title="Préparer un contrôle" description="Organiser tes priorités" />
        <ModuleCard icon={CalendarDays} title="Organiser mon travail" description="Structurer ta semaine" />
      </div>
      <div className="assistant-chat-placeholder">
        <span className="module-empty-icon"><Sparkles size={24} /></span>
        <strong>L'assistant sera bientôt disponible.</strong>
        <p>Aucune connexion IA n'est activée pour le moment.</p>
      </div>
    </section>
  );
}

function ModuleSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="module-section"><div className="module-section-heading"><div><span className="section-kicker">STUDY OS</span><h2>{title}</h2><p>{description}</p></div></div>{children}</section>;
}
