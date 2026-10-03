"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../admin.module.css";
import { createFormAction, updateFormAction } from "./actions.ts";

type QuestionType = "single_choice" | "multiple_choice" | "short_text" | "long_text";

export interface QuestionState {
  label: string;
  description: string;
  type: QuestionType;
  required: boolean;
  /** Seçenekler, satır başına bir tane. */
  options: string;
}

export interface FormEditorInitial {
  slug: string;
  title: string;
  description: string;
  audience: "public" | "authenticated" | "early_access";
  kind: "survey" | "onboarding";
  allowSkip: boolean;
  allowMultipleResponses: boolean;
  startsAt: string;
  endsAt: string;
  questions: QuestionState[];
}

const EMPTY_QUESTION: QuestionState = {
  label: "",
  description: "",
  type: "single_choice",
  required: false,
  options: "",
};

const TYPE_LABELS: Record<QuestionType, string> = {
  single_choice: "Tek seçim",
  multiple_choice: "Çoklu seçim",
  short_text: "Kısa metin",
  long_text: "Uzun metin",
};

/**
 * Form oluşturma ve düzenleme (docs/decisions/0058). Sınırlar ve asıl
 * doğrulama core'da (`validateFormDefinition`). Yanıt alınmış formun soruları
 * kilitlidir; adres yayından sonra kilitlidir (paylaşılan bağlantı bozulmasın).
 */
export function FormEditorClient(
  props:
    | { mode: "create"; initial: FormEditorInitial }
    | {
        mode: "edit";
        id: number;
        expectedUpdatedAt: number;
        initial: FormEditorInitial;
        questionsLocked: boolean;
        slugLocked: boolean;
      },
) {
  const router = useRouter();
  const editing = props.mode === "edit";
  const questionsLocked = props.mode === "edit" && props.questionsLocked;
  const slugLocked = props.mode === "edit" && props.slugLocked;
  const [state, setState] = useState<FormEditorInitial>(props.initial);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function patch(update: Partial<FormEditorInitial>) {
    setState((current) => ({ ...current, ...update }));
  }

  function patchQuestion(index: number, update: Partial<QuestionState>) {
    setState((current) => ({
      ...current,
      questions: current.questions.map((q, i) => (i === index ? { ...q, ...update } : q)),
    }));
  }

  function moveQuestion(index: number, delta: -1 | 1) {
    setState((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.questions.length) return current;
      const questions = [...current.questions];
      const [moved] = questions.splice(index, 1);
      if (moved) questions.splice(target, 0, moved);
      return { ...current, questions };
    });
  }

  function payload() {
    return {
      slug: state.slug,
      title: state.title,
      description: state.description,
      audience: state.audience,
      kind: state.kind,
      allowSkip: state.allowSkip,
      allowMultipleResponses: state.allowMultipleResponses,
      startsAt: state.startsAt,
      endsAt: state.endsAt,
      questions: state.questions.map((q) => ({
        label: q.label,
        description: q.description,
        type: q.type,
        required: q.required,
        options:
          q.type === "single_choice" || q.type === "multiple_choice" ? q.options.split("\n") : [],
      })),
    };
  }

  async function submit() {
    setPending(true);
    setMessage(null);
    try {
      if (props.mode === "create") {
        const result = await createFormAction(payload());
        if (!result.ok) {
          setMessage({ text: result.message, error: true });
          return;
        }
        router.push(`/yonetim/formlar/${result.id}`);
        return;
      }
      const result = await updateFormAction(props.id, payload(), props.expectedUpdatedAt);
      if (!result.ok) {
        setMessage({ text: result.message, error: true });
        return;
      }
      setMessage({ text: "Kaydedildi.", error: false });
      router.refresh();
    } catch {
      setMessage({ text: "Kaydedilemedi. Tekrar dene.", error: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className={styles.formGrid}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        <span className={styles.meta}>Başlık (kullanıcıya görünür)</span>
        <input
          required
          maxLength={200}
          value={state.title}
          onChange={(event) => patch({ title: event.target.value })}
        />
      </label>
      <label>
        <span className={styles.meta}>Açıklama (isteğe bağlı)</span>
        <textarea
          maxLength={2000}
          className={styles.textArea}
          value={state.description}
          onChange={(event) => patch({ description: event.target.value })}
        />
      </label>
      <label>
        <span className={styles.meta}>
          Adres: /anket/… (küçük harf, rakam, tire{slugLocked ? "; yayından sonra değişmez" : ""})
        </span>
        <input
          required
          minLength={3}
          maxLength={80}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          disabled={slugLocked}
          value={state.slug}
          onChange={(event) => patch({ slug: event.target.value })}
        />
      </label>
      <label>
        <span className={styles.meta}>Tür</span>
        <select
          value={state.kind}
          onChange={(event) => {
            const kind = event.target.value as FormEditorInitial["kind"];
            patch({
              kind,
              ...(kind === "onboarding" && state.audience === "public"
                ? { audience: "early_access" as const }
                : {}),
            });
          }}
        >
          <option value="survey">Anket</option>
          <option value="onboarding">Onboarding (erken erişim sonrası bir kez gösterilir)</option>
        </select>
      </label>
      <label>
        <span className={styles.meta}>Hedef kitle</span>
        <select
          value={state.audience}
          onChange={(event) =>
            patch({ audience: event.target.value as FormEditorInitial["audience"] })
          }
        >
          <option value="public" disabled={state.kind === "onboarding"}>
            Herkese açık (giriş gerekmez)
          </option>
          <option value="authenticated">Giriş yapmış kullanıcılar</option>
          <option value="early_access">Erken erişim üyeleri</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={state.allowSkip}
          onChange={(event) => patch({ allowSkip: event.target.checked })}
        />{" "}
        <span className={styles.meta}>
          “Şimdilik geç” seçeneği olsun (giriş yapmış kullanıcılar)
        </span>
      </label>
      <label>
        <input
          type="checkbox"
          checked={state.allowMultipleResponses}
          onChange={(event) => patch({ allowMultipleResponses: event.target.checked })}
        />{" "}
        <span className={styles.meta}>Aynı kişi birden fazla kez yanıtlayabilsin</span>
      </label>
      <label>
        <span className={styles.meta}>Başlangıç (Türkiye saati, isteğe bağlı)</span>
        <input
          type="datetime-local"
          value={state.startsAt}
          onChange={(event) => patch({ startsAt: event.target.value })}
        />
      </label>
      <label>
        <span className={styles.meta}>Bitiş (Türkiye saati, isteğe bağlı)</span>
        <input
          type="datetime-local"
          value={state.endsAt}
          onChange={(event) => patch({ endsAt: event.target.value })}
        />
      </label>

      <h3 className={styles.sectionTitle}>Sorular</h3>
      {questionsLocked ? (
        <p className={styles.muted}>
          Bu forma yanıt geldiği için sorular değiştirilemez. Başlık, açıklama, tarih ve hedef kitle
          düzenlenebilir.
        </p>
      ) : null}
      {state.questions.map((question, index) => (
        <fieldset
          // biome-ignore lint/suspicious/noArrayIndexKey: soru kimliği yok; sıra kimliktir.
          key={index}
          disabled={questionsLocked}
          className={styles.formGrid}
        >
          <legend className={styles.meta}>Soru {index + 1}</legend>
          <label>
            <span className={styles.meta}>Soru metni</span>
            <input
              required
              maxLength={300}
              value={question.label}
              onChange={(event) => patchQuestion(index, { label: event.target.value })}
            />
          </label>
          <label>
            <span className={styles.meta}>Yardımcı açıklama (isteğe bağlı)</span>
            <input
              maxLength={1000}
              value={question.description}
              onChange={(event) => patchQuestion(index, { description: event.target.value })}
            />
          </label>
          <label>
            <span className={styles.meta}>Soru türü</span>
            <select
              value={question.type}
              onChange={(event) =>
                patchQuestion(index, { type: event.target.value as QuestionType })
              }
            >
              {(Object.keys(TYPE_LABELS) as QuestionType[]).map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          {question.type === "single_choice" || question.type === "multiple_choice" ? (
            <label>
              <span className={styles.meta}>Seçenekler (her satıra bir seçenek, en az 2)</span>
              <textarea
                className={styles.textArea}
                value={question.options}
                onChange={(event) => patchQuestion(index, { options: event.target.value })}
              />
            </label>
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={question.required}
              onChange={(event) => patchQuestion(index, { required: event.target.checked })}
            />{" "}
            <span className={styles.meta}>Zorunlu</span>
          </label>
          <div className={styles.row}>
            <Button
              type="button"
              variant="secondary"
              disabled={index === 0}
              onClick={() => moveQuestion(index, -1)}
            >
              Yukarı
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={index === state.questions.length - 1}
              onClick={() => moveQuestion(index, 1)}
            >
              Aşağı
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => patch({ questions: state.questions.filter((_, i) => i !== index) })}
            >
              Sil
            </Button>
          </div>
        </fieldset>
      ))}
      {questionsLocked ? null : (
        <div className={styles.row}>
          <Button
            type="button"
            variant="secondary"
            disabled={state.questions.length >= 30}
            onClick={() => patch({ questions: [...state.questions, { ...EMPTY_QUESTION }] })}
          >
            Soru ekle
          </Button>
        </div>
      )}

      {message ? (
        <p
          role={message.error ? "alert" : "status"}
          className={message.error ? styles.statusBad : styles.muted}
        >
          {message.text}
        </p>
      ) : null}
      <div className={styles.row}>
        <Button type="submit" variant="primary" disabled={pending}>
          {editing ? "Değişiklikleri kaydet" : "Taslak oluştur"}
        </Button>
      </div>
    </form>
  );
}
