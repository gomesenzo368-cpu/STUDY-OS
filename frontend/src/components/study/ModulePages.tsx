import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
  Send,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";
import { api } from "../../api";
import SubjectIcon from "../SubjectIcon";
import type { Chapter, Course, RevisionAnswerResult, RevisionReviewItem, RevisionSession, RevisionSessionQuestion, Subject } from "../../types";
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
}: {
  subjects: Subject[];
  chapters: Chapter[];
  courses: Course[];
}) {
  const [sessions, setSessions] = useState<RevisionSession[]>([]);
  const [recommendations, setRecommendations] = useState<RevisionReviewItem[] | null>(null);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [recommendationsVisible, setRecommendationsVisible] = useState(false);
  const [activeSession, setActiveSession] = useState<RevisionSession | null>(null);
  const [activeCourse, setActiveCourse] = useState<Course | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answerValue, setAnswerValue] = useState<string | boolean | null>(null);
  const [feedback, setFeedback] = useState<RevisionAnswerResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const recentCourses = [...courses].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 3);
  const questionList = activeSession?.questions ?? [];
  const answerList = activeSession?.answers ?? [];
  const answeredIds = new Set(answerList.map((answer) => answer.snapshot_question_id ?? answer.question_id).filter((id): id is number => typeof id === "number"));
  const currentQuestion = questionList[questionIndex];
  const sessionId = activeSession?.id ?? activeSession?.session_id;
  const courseTitle = (courseId: number) => courses.find((course) => course.id === courseId)?.title ?? "Cours supprimé";

  useEffect(() => {
    let mounted = true;
    api.getRevisionSessions()
      .then((loadedSessions) => { if (mounted) setSessions(loadedSessions); })
      .catch((loadError: unknown) => { if (mounted) setError(loadError instanceof Error ? loadError.message : "L'historique n'a pas pu être chargé."); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  const refreshSessions = async () => {
    try { setSessions(await api.getRevisionSessions()); } catch { /* Keep the current page usable if refreshing the history fails. */ }
  };

  const openRecommendations = async () => {
    setRecommendationsVisible(true);
    setRecommendationsLoading(true);
    setError("");
    try {
      setRecommendations(await api.getRevisionRecommendations());
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : "Les recommandations n'ont pas pu être chargées.");
    } finally {
      setRecommendationsLoading(false);
      document.getElementById("revision-recommendations")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const startSession = async (course: Course) => {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const session = await api.startRevisionSession(course.id);
      setActiveSession({ ...session, answers: session.answers ?? [] });
      setActiveCourse(course);
      setQuestionIndex(0);
      setAnswerValue(null);
      setFeedback(null);
    } catch (startError: unknown) {
      setError(startError instanceof Error ? startError.message : "La session n'a pas pu démarrer.");
    } finally {
      setWorking(false);
    }
  };

  const resumeSession = async (session: RevisionSession) => {
    const id = session.id ?? session.session_id;
    if (!id) return;
    setWorking(true);
    setError("");
    try {
      const loadedSession = await api.getRevisionSession(id);
      const loadedAnswers = loadedSession.answers ?? [];
      const completedQuestionIds = new Set(loadedAnswers.map((answer) => answer.snapshot_question_id ?? answer.question_id).filter((questionId): questionId is number => typeof questionId === "number"));
      const nextIndex = (loadedSession.questions ?? []).findIndex((question) => !completedQuestionIds.has(question.question_id));
      setActiveSession({ ...loadedSession, answers: loadedAnswers });
      setActiveCourse(courses.find((course) => course.id === loadedSession.course_id) ?? null);
      setQuestionIndex(nextIndex < 0 ? (loadedSession.questions ?? []).length : nextIndex);
      setAnswerValue(null);
      setFeedback(null);
    } catch (resumeError: unknown) {
      setError(resumeError instanceof Error ? resumeError.message : "La session n'a pas pu être reprise.");
    } finally {
      setWorking(false);
    }
  };

  const submitAnswer = async () => {
    if (!sessionId || !currentQuestion || answerValue === null || answerValue === "") return;
    setWorking(true);
    setError("");
    try {
      const result = await api.submitRevisionAnswer(sessionId, currentQuestion.question_id, answerValue);
      setFeedback(result);
      setActiveSession((current) => current ? {
        ...current,
        correct_answers: result.correct_answers,
        score: result.score,
        answers: [...(current.answers ?? []), { snapshot_question_id: currentQuestion.question_id, answer: answerValue, is_correct: result.is_correct }],
      } : current);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "La réponse n'a pas pu être enregistrée.");
    } finally {
      setWorking(false);
    }
  };

  const advanceSession = async () => {
    if (!activeSession) return;
    const completedQuestionIds = new Set((activeSession.answers ?? []).map((answer) => answer.snapshot_question_id ?? answer.question_id).filter((id): id is number => typeof id === "number"));
    const nextIndex = questionList.findIndex((question) => !completedQuestionIds.has(question.question_id));
    if (nextIndex >= 0) {
      setFeedback(null);
      setAnswerValue(null);
      setQuestionIndex(nextIndex);
      return;
    }
    if (!sessionId) return;
    setWorking(true);
    setError("");
    try {
      await api.closeRevisionSession(sessionId, "complete");
      setFeedback(null);
      setActiveSession(null);
      setActiveCourse(null);
      setNotice("Session terminée. Ton résultat est enregistré dans l'historique.");
      await refreshSessions();
    } catch (finishError: unknown) {
      setError(finishError instanceof Error ? finishError.message : "La session n'a pas pu être terminée.");
    } finally {
      setWorking(false);
    }
  };

  const abandonSession = async () => {
    if (!sessionId) return;
    setWorking(true);
    setError("");
    try {
      await api.closeRevisionSession(sessionId, "abandon");
      setActiveSession(null);
      setActiveCourse(null);
      setFeedback(null);
      setNotice("Session mise en pause et conservée dans ton historique.");
      await refreshSessions();
    } catch (abandonError: unknown) {
      setError(abandonError instanceof Error ? abandonError.message : "La session n'a pas pu être mise en pause.");
    } finally {
      setWorking(false);
    }
  };

  const renderAnswerControl = (question: RevisionSessionQuestion) => {
    if (question.question_type === "short_answer") {
      return <label className="revision-short-answer"><span>Ta réponse</span><input value={typeof answerValue === "string" ? answerValue : ""} onChange={(event) => setAnswerValue(event.target.value)} disabled={working || Boolean(feedback)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitAnswer(); } }} /></label>;
    }
    const choices = question.question_type === "true_false"
      ? [{ id: "true", text: "Vrai", value: true }, { id: "false", text: "Faux", value: false }]
      : (question.choices ?? []).map((choice) => ({ ...choice, value: choice.id }));
    return <div className="revision-choice-list" role="group" aria-label="Choisir une réponse">
      {choices.map((choice) => (
        <button className={`revision-choice ${answerValue === choice.value ? "is-selected" : ""}`} key={choice.id} type="button" onClick={() => setAnswerValue(choice.value)} disabled={working || Boolean(feedback)}>
          <span>{choice.text}</span>{answerValue === choice.value && <CheckCircle2 size={18} />}
        </button>
      ))}
    </div>;
  };

  return (
    <section className="module-page revisions-page">
      {activeSession ? (
        <div className="revision-workspace">
          <button className="back-button" onClick={abandonSession} disabled={working}><ArrowLeft size={17} /> Mettre en pause</button>
          <div className="revision-workspace-heading">
            <span className="eyebrow"><span className="status-dot" /> SESSION DE RÉVISION</span>
            <h1>{activeCourse?.title ?? courseTitle(activeSession.course_id)}</h1>
            <p>{answeredIds.size} réponse{answeredIds.size === 1 ? "" : "s"} enregistrée{answeredIds.size === 1 ? "" : "s"} sur {activeSession.total_questions} · Score actuel {activeSession.score}%</p>
            <progress value={answeredIds.size} max={Math.max(activeSession.total_questions, 1)} aria-label="Progression de la session" />
          </div>
          {currentQuestion ? (
            <article className="revision-question">
              <span className="revision-question-count">QUESTION {Math.min(questionIndex + 1, questionList.length)} / {questionList.length}</span>
              <h2>{currentQuestion.question_text}</h2>
              {renderAnswerControl(currentQuestion)}
              {feedback && <div className={`revision-feedback ${feedback.is_correct ? "is-correct" : "is-incorrect"}`} role="status">
                <strong>{feedback.is_correct ? "Bonne réponse" : "Réponse enregistrée"}</strong>
                <span>{feedback.correct_answers} bonne{feedback.correct_answers === 1 ? "" : "s"} réponse{feedback.correct_answers === 1 ? "" : "s"} sur {feedback.total_questions} · {feedback.score}%</span>
              </div>}
              {error && <p className="revision-error" role="alert">{error}</p>}
              <div className="revision-question-actions">
                {feedback ? <button className="primary-button" onClick={() => void advanceSession()} disabled={working}>{working ? "Enregistrement…" : "Continuer"} <ArrowRight size={16} /></button> : <button className="primary-button" onClick={() => void submitAnswer()} disabled={working || answerValue === null || answerValue === ""}>{working ? "Enregistrement…" : "Valider ma réponse"} <CheckCircle2 size={16} /></button>}
              </div>
            </article>
          ) : (
            <div className="revision-question revision-session-empty">
              <span className="module-empty-icon"><CheckCircle2 size={24} /></span>
              <h2>{activeSession.total_questions ? "Toutes les questions sont traitées" : "Pas encore de questions pour ce cours"}</h2>
              <p>{activeSession.total_questions ? "Tu peux enregistrer le résultat de cette session." : "Ajoute des questions à ce cours pour lancer une session de quiz."}</p>
              {activeSession.total_questions > 0 && <button className="primary-button" onClick={() => void advanceSession()} disabled={working}>Terminer la session <CheckCircle2 size={16} /></button>}
              {error && <p className="revision-error" role="alert">{error}</p>}
            </div>
          )}
        </div>
      ) : (
        <>
          <ModuleHeader eyebrow="RÉVISIONS" title="Qu'est-ce que tu veux réviser aujourd'hui ?" description="Choisis un cours, réponds aux questions et reprends tes sessions quand tu veux." />
          <div className="module-action-grid">
            <ModuleCard icon={Play} title="Révision rapide" description={recentCourses[0]?.title ?? "Choisis un cours pour commencer"} onClick={recentCourses[0] ? () => void startSession(recentCourses[0]) : undefined} />
            <ModuleCard icon={BrainCircuit} title="Mes révisions" description={loading ? "Chargement des sessions…" : sessions.length ? `${sessions.length} session${sessions.length === 1 ? "" : "s"} enregistrée${sessions.length === 1 ? "" : "s"}` : "Tes sessions apparaîtront ici"} onClick={() => document.getElementById("revision-sessions")?.scrollIntoView({ behavior: "smooth" })} />
            <ModuleCard icon={Sparkles} title="Révisions recommandées" description={recommendations === null ? "Revoir tes réponses difficiles" : `${recommendations.length} réponse${recommendations.length === 1 ? "" : "s"} à retravailler`} onClick={() => void openRecommendations()} />
          </div>
          {notice && <p className="revision-notice" role="status">{notice}</p>}
          {error && <p className="revision-error" role="alert">{error}</p>}

          <ModuleSection title="Mes matières" description="Commence une session sur un cours de la matière choisie.">
            {subjects.length ? (
              <div className="module-subject-grid">
                {subjects.map((subject) => {
                  const subjectChapters = chapters.filter((chapter) => chapter.subject_id === subject.id);
                  const subjectCourses = courses.filter((course) => subjectChapters.some((chapter) => chapter.id === course.chapter_id)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
                  return (
                    <article className="module-subject-card" key={subject.id}>
                      <span className="module-subject-icon"><SubjectIcon name={subject.icon} size={20} /></span>
                      <strong>{subject.name}</strong>
                      <span>{subjectChapters.length} chapitre{subjectChapters.length === 1 ? "" : "s"} · {subjectCourses.length} cours</span>
                      <button className="text-button" disabled={!subjectCourses.length || working} onClick={() => subjectCourses[0] && void startSession(subjectCourses[0])}>{subjectCourses.length ? "Réviser le cours récent" : "Aucun cours"} <ArrowRight size={15} /></button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyModuleState icon={GraduationCap} title="Tes matières apparaîtront ici" description="Ajoute d'abord une matière et un cours pour commencer à réviser." />
            )}
          </ModuleSection>

          <ModuleSection title="Reprendre une session" description="Tes réponses sont enregistrées au fur et à mesure.">
            {loading ? <p className="revision-muted">Chargement de tes sessions…</p> : sessions.some((session) => session.status === "in_progress") ? (
              <div className="module-course-list">
                {sessions.filter((session) => session.status === "in_progress").map((session) => (
                  <button className="module-course-row" key={session.id ?? session.session_id} onClick={() => void resumeSession(session)} disabled={working}>
                    <span className="module-row-icon"><FileQuestion size={18} /></span>
                    <span><strong>{courseTitle(session.course_id)}</strong><small>{session.correct_answers}/{session.total_questions} bonnes réponses · {session.score}%</small></span>
                    <ArrowRight size={17} />
                  </button>
                ))}
              </div>
            ) : <EmptyModuleState icon={Clock3} title="Aucune session à reprendre" description="Démarre une révision depuis une matière ou un cours." />}
          </ModuleSection>

          <ModuleSection title="Choisir un cours" description="Lance un nouveau quiz à partir des questions préparées pour tes cours.">
            {recentCourses.length ? <div className="module-course-list">
              {recentCourses.map((course) => (
                <button className="module-course-row" key={course.id} onClick={() => void startSession(course)} disabled={working}>
                  <span className="module-row-icon"><FileQuestion size={18} /></span>
                  <span><strong>{course.title}</strong><small>{chapters.find((chapter) => chapter.id === course.chapter_id)?.name ?? "Cours"}</small></span>
                  <ArrowRight size={17} />
                </button>
              ))}
            </div> : <EmptyModuleState icon={Target} title="Aucun cours disponible" description="Ajoute un cours pour préparer tes premières révisions." />}
          </ModuleSection>

          {recommendationsVisible && <div id="revision-recommendations">
            <ModuleSection title="Révisions recommandées" description="Questions auxquelles tu as répondu incorrectement lors de tes sessions.">
              {recommendationsLoading ? <p className="revision-muted">Chargement des recommandations…</p> : recommendations?.length ? <div className="revision-history-list">
                {recommendations.map((item) => (
                  <div className="revision-history-row" key={item.id}>
                    <span className="module-row-icon"><Target size={18} /></span>
                    <span><strong>{item.question_text_snapshot}</strong><small>À revoir · session {item.session_id}</small></span>
                  </div>
                ))}
              </div> : <EmptyModuleState icon={Sparkles} title="Aucune réponse à retravailler" description="Les réponses incorrectes de tes prochaines sessions apparaîtront ici." />}
            </ModuleSection>
          </div>}

          <div id="revision-sessions">
            <ModuleSection title="Historique" description="Retrouve les résultats de tes sessions précédentes.">
              {loading ? <p className="revision-muted">Chargement de ton historique…</p> : sessions.filter((session) => session.status !== "in_progress").length ? <div className="revision-history-list">
                {sessions.filter((session) => session.status !== "in_progress").slice(0, 8).map((session) => (
                  <div className="revision-history-row" key={session.id ?? session.session_id}>
                    <span className="module-row-icon"><CheckCircle2 size={18} /></span>
                    <span><strong>{courseTitle(session.course_id)}</strong><small>{session.status === "completed" ? "Terminée" : "Mise en pause"} · {session.correct_answers}/{session.total_questions} bonnes réponses</small></span>
                    <strong className="revision-history-score">{session.score}%</strong>
                  </div>
                ))}
              </div> : <EmptyModuleState icon={Clock3} title="Pas encore d'historique" description="Tes sessions terminées ou mises en pause apparaîtront ici." />}
            </ModuleSection>
          </div>
        </>
      )}
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

type AssistantMessage = { role: "user" | "assistant"; content: string };

function assistantErrorText(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "Ta session a expiré. Reconnecte-toi pour continuer.") return "Ta session semble expirée. Reconnecte-toi puis réessaie.";
  if (code === "no_provider_configured" || code === "provider_not_configured") return "L'assistant n'est pas encore disponible. Réessaie plus tard.";
  if (["all_providers_failed", "provider_unavailable", "timeout", "network_error", "rate_limited", "quota_exceeded"].includes(code)) {
    return "L'assistant est temporairement indisponible. Réessaie dans un instant.";
  }
  return "La réponse n'a pas pu être générée. Réessaie dans un instant.";
}

export function AssistantPage() {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isSending]);

  const prompts = [
    { icon: FileQuestion, title: "Explique-moi un cours", description: "Comprendre une notion", message: "Explique-moi une notion simplement." },
    { icon: BrainCircuit, title: "Fais-moi réviser", description: "Consolider tes connaissances", message: "Aide-moi à réviser une notion." },
    { icon: CheckCircle2, title: "Teste-moi", description: "Vérifier ce que tu sais", message: "Pose-moi une question pour réviser." },
    { icon: ClipboardCheck, title: "Préparer un contrôle", description: "Organiser tes priorités", message: "Aide-moi à préparer un contrôle." },
    { icon: CalendarDays, title: "Organiser mon travail", description: "Structurer ta semaine", message: "Aide-moi à organiser mon travail." },
  ];

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || isSending) return;

    setMessages((current) => [...current, { role: "user", content: message }]);
    setDraft("");
    setError("");
    setIsSending(true);
    try {
      const response = await api.askAssistant(message);
      if (response.status !== "completed" || !response.message) {
        setError(assistantErrorText(new Error(response.error_code ?? "")));
        return;
      }
      setMessages((current) => [...current, { role: "assistant", content: response.message! }]);
    } catch (requestError) {
      setError(assistantErrorText(requestError));
    } finally {
      setIsSending(false);
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <section className="module-page assistant-page">
      <ModuleHeader eyebrow="ASSISTANT STUDY OS" title="Que veux-tu faire ?" description="Pose une question sur tes études et avance étape par étape." />
      <div className="assistant-prompt-grid">
        {prompts.map(({ icon, title, description, message }) => (
          <ModuleCard
            key={title}
            icon={icon}
            title={title}
            description={description}
            onClick={() => {
              setDraft(message);
              composerRef.current?.focus();
            }}
          />
        ))}
      </div>

      <section className="assistant-chat" aria-label="Conversation avec l'assistant">
        <div className="assistant-chat-heading">
          <span className="assistant-chat-mark"><Sparkles size={17} /></span>
          <div><strong>Assistant STUDY OS</strong><span>Conversation privée à cette session</span></div>
        </div>
        <div className="assistant-transcript" role="log" aria-live="polite" aria-relevant="additions text">
          {messages.length === 0 ? (
            <div className="assistant-welcome">
              <span className="module-empty-icon"><MessageCircle size={22} /></span>
              <strong>Par quoi commence-t-on ?</strong>
              <p>Écris ta question ou choisis un point de départ.</p>
            </div>
          ) : messages.map((message, index) => (
            <article className={`assistant-message assistant-message--${message.role}`} key={`${message.role}-${index}`}>
              {message.role === "assistant" && <span className="assistant-message-mark"><Sparkles size={15} /></span>}
              <div className="assistant-message-bubble">
                <span>{message.role === "user" ? "Toi" : "Assistant"}</span>
                <p>{message.content}</p>
              </div>
            </article>
          ))}
          {isSending && (
            <div className="assistant-pending" role="status">
              <span className="assistant-message-mark"><Sparkles size={15} /></span>
              <span>L'assistant prépare une réponse…</span>
            </div>
          )}
          <div ref={transcriptEndRef} />
        </div>

        <form className="assistant-composer" onSubmit={sendMessage}>
          {error && <p className="assistant-error" role="alert">{error}</p>}
          <label className="sr-only" htmlFor="assistant-message">Ton message</label>
          <textarea
            id="assistant-message"
            ref={composerRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Écris ton message…"
            rows={2}
            maxLength={8000}
            disabled={isSending}
          />
          <div className="assistant-composer-footer">
            <span>Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne</span>
            <button className="primary-button" type="submit" disabled={!draft.trim() || isSending}>
              <Send size={16} /> {isSending ? "Envoi…" : "Envoyer"}
            </button>
          </div>
        </form>
      </section>
    </section>
  );
}

function ModuleSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="module-section"><div className="module-section-heading"><div><span className="section-kicker">STUDY OS</span><h2>{title}</h2><p>{description}</p></div></div>{children}</section>;
}
