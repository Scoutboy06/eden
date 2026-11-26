import { useEffect, useRef, useState } from "react";
import {
  AlertCircleIcon,
  ArrowUp01Icon,
  CircleCheckIcon,
  Loading03Icon,
  SquareStopIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Message, MessageContent, MessageGroup } from "@/components/ui/message";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  sendConversationMessage,
  listConversationModels,
  replyToPermission,
  replyToForm,
  stopConversation,
  type Conversation,
  type ConversationForm,
  type ConversationModel,
} from "@/pages/conversations";
import { Streamdown } from "streamdown";
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";

export function OpenCodeConversationPane({
  conversation,
  refresh,
}: {
  conversation: Conversation;
  refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [answeringPermission, setAnsweringPermission] = useState<string | null>(null);
  const [answeringForm, setAnsweringForm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ConversationModel[] | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string | undefined>(
    conversation.selectedModelKey ?? undefined,
  );
  const [loadingModels, setLoadingModels] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastMessage = conversation.messages.at(-1);
  const approvalsKey = conversation.approvals?.map(({ id }) => id).join(",");
  const active = conversation.status === "active" || conversation.status === "blocked" || sending;
  const selectedModel = models?.find(({ key }) => key === selectedModelKey);
  const groupedModels = models?.some(({ group }) => group);

  useEffect(() => {
    if (!nearBottom.current) return;
    const container = transcript.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [
    approvalsKey,
    conversation.messages.length,
    lastMessage?.createdAt,
    lastMessage?.role,
    lastMessage?.text,
  ]);

  useEffect(() => {
    setSelectedModelKey(conversation.selectedModelKey ?? undefined);
  }, [conversation.id, conversation.selectedModelKey]);

  useEffect(() => {
    setModels(null);
  }, [conversation.id]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || active) return;
    setSending(true);
    setError(null);
    try {
      await sendConversationMessage(conversation.id, text, selectedModelKey ?? null);
      setDraft("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send message.");
      await refresh();
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    setStopping(true);
    setError(null);
    try {
      await stopConversation(conversation.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop this reply.");
      await refresh();
    } finally {
      setStopping(false);
    }
  }

  async function answerPermission(requestID: string, decision: "once" | "always" | "reject") {
    setAnsweringPermission(requestID);
    setError(null);
    try {
      await replyToPermission(conversation.id, requestID, decision);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not answer this permission request.",
      );
    } finally {
      await refresh();
      setAnsweringPermission(null);
    }
  }

  async function answerForm(formID: string, answer: Record<string, string | number | boolean>) {
    setAnsweringForm(formID);
    setError(null);
    try {
      await replyToForm(conversation.id, formID, answer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not answer this OpenCode form.");
    } finally {
      await refresh();
      setAnsweringForm(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={transcript}
        role="region"
        aria-label="Conversation transcript"
        onScroll={(event) => {
          const element = event.currentTarget;
          nearBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
      >
        {conversation.messages.length ? (
          <MessageGroup className="mx-auto max-w-3xl gap-5">
            {conversation.messages.map((message, index) => (
              <Message
                key={`${message.createdAt}-${index}`}
                align={message.role === "user" ? "end" : "start"}
              >
                <MessageContent className="max-w-full">
                  {message.role === "user" ? (
                    <Bubble align="end" variant="muted">
                      <BubbleContent className="whitespace-pre-wrap">{message.text}</BubbleContent>
                    </Bubble>
                  ) : (
                    <>
                      {message.tools?.length ? (
                        <Trace className="px-3 pt-2">
                          {message.tools.map((tool) => (
                            <TraceLine
                              key={tool.id}
                              status={
                                tool.status === "running"
                                  ? "running"
                                  : tool.status === "failed"
                                    ? "error"
                                    : undefined
                              }
                            >
                              <TraceIcon>
                                {tool.status === "running" ? (
                                  <HugeiconsIcon icon={Loading03Icon} className="animate-spin" />
                                ) : tool.status === "failed" ? (
                                  <HugeiconsIcon icon={AlertCircleIcon} />
                                ) : tool.status === "completed" ? (
                                  <HugeiconsIcon icon={CircleCheckIcon} />
                                ) : (
                                  <HugeiconsIcon icon={Wrench01Icon} />
                                )}
                              </TraceIcon>
                              <TraceTitle>
                                {tool.status === "running"
                                  ? `Running ${tool.name}`
                                  : tool.status === "failed"
                                    ? `Failed ${tool.name}`
                                    : `Completed ${tool.name}`}
                              </TraceTitle>
                            </TraceLine>
                          ))}
                        </Trace>
                      ) : null}
                      <Streamdown
                        className="px-3 py-2 text-sm leading-relaxed"
                        isAnimating={conversation.status === "active"}
                      >
                        {message.text}
                      </Streamdown>
                    </>
                  )}
                </MessageContent>
              </Message>
            ))}
            {active &&
            !(
              conversation.status === "blocked" &&
              (conversation.approvals?.length || conversation.forms?.length)
            ) ? (
              <Message>
                <MessageContent>
                  <p className="px-3 py-2 text-sm text-muted-foreground" role="status">
                    {conversation.status === "blocked"
                      ? "OpenCode is waiting for a permission or form response…"
                      : "OpenCode is working…"}
                  </p>
                </MessageContent>
              </Message>
            ) : null}
            {conversation.approvals?.map((approval) => (
              <Message key={approval.id}>
                <MessageContent>
                  <section
                    aria-labelledby={`permission-${approval.id}`}
                    className="mx-3 max-w-full rounded-lg border border-border bg-card p-4"
                  >
                    <h2 id={`permission-${approval.id}`} className="text-sm font-semibold">
                      OpenCode permission requested
                    </h2>
                    <p className="mt-2 text-sm">
                      {approval.message ?? `Allow ${approval.action}?`}
                    </p>
                    <p className="mt-2 break-all text-xs text-muted-foreground">
                      {approval.action}: {approval.resources.join(", ")}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={answeringPermission !== null}
                        onClick={() => void answerPermission(approval.id, "once")}
                      >
                        Allow once
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={answeringPermission !== null}
                        onClick={() => void answerPermission(approval.id, "always")}
                      >
                        Always allow
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={answeringPermission !== null}
                        onClick={() => void answerPermission(approval.id, "reject")}
                      >
                        Reject
                      </Button>
                    </div>
                  </section>
                </MessageContent>
              </Message>
            ))}
            {conversation.forms?.map((form) => (
              <Message key={form.id}>
                <MessageContent>
                  <NativeFormCard
                    form={form}
                    disabled={answeringForm !== null || answeringPermission !== null}
                    onSubmit={(answer) => void answerForm(form.id, answer)}
                  />
                </MessageContent>
              </Message>
            ))}
          </MessageGroup>
        ) : (
          <div className="flex h-full items-center justify-center text-center">
            <div>
              <h2 className="text-sm font-medium">Start a conversation</h2>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                This conversation is saved locally. OpenCode starts when you send the first message.
              </p>
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-border p-4">
        <form className="mx-auto max-w-3xl" onSubmit={submit}>
          <InputGroup>
            <InputGroupTextarea
              aria-label="Message OpenCode"
              placeholder="Message OpenCode…"
              value={draft}
              disabled={active}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              className="max-h-40 min-h-14 overflow-y-auto p-3 leading-6"
            />
            <InputGroupAddon align="block-end">
              <Select
                value={selectedModelKey ?? "__default__"}
                onValueChange={(value) =>
                  setSelectedModelKey(value === "__default__" ? undefined : (value ?? undefined))
                }
                onOpenChange={(open) => {
                  if (!open || models !== null || loadingModels) return;
                  setLoadingModels(true);
                  void listConversationModels(conversation.id)
                    .then(setModels)
                    .catch((cause) => {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not load available OpenCode models.",
                      );
                    })
                    .finally(() => setLoadingModels(false));
                }}
              >
                <SelectTrigger
                  size="sm"
                  disabled={active}
                  aria-label="Choose OpenCode model"
                  className="mr-auto max-w-56 min-w-0 border-transparent"
                >
                  <SelectValue>
                    {selectedModel
                      ? groupedModels
                        ? selectedModel.name
                        : `${selectedModel.name} · ${selectedModel.providerID}`
                      : selectedModelKey
                        ? models === null
                          ? (conversation.selectedModelLabel ?? "Selected model")
                          : "Model unavailable"
                        : "Default model"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent
                  align="start"
                  className="max-h-[min(24rem,60dvh,var(--available-height))]"
                >
                  <SelectItem value="__default__">Default model</SelectItem>
                  {loadingModels ? (
                    <SelectItem value="__loading__" disabled>
                      Loading models…
                    </SelectItem>
                  ) : null}
                  {models?.length === 0 ? (
                    <SelectItem value="__empty__" disabled>
                      No available models
                    </SelectItem>
                  ) : null}
                  {groupedModels
                    ? Object.entries(
                        Object.groupBy(
                          models?.filter(({ group }) => group) ?? [],
                          ({ group }) => group!.key,
                        ),
                      ).map(([key, groupModels]) => (
                        <SelectGroup key={key}>
                          <SelectLabel>{groupModels?.[0]?.group?.label ?? key}</SelectLabel>
                          {groupModels?.map((model) => (
                            <SelectItem key={model.key} value={model.key}>
                              {model.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))
                    : models?.map((model) => (
                        <SelectItem key={model.key} value={model.key}>
                          {model.name} · {model.providerID}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
              {conversation.status === "active" || conversation.status === "blocked" ? (
                <InputGroupButton
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={stopping}
                  onClick={() => void stop()}
                  aria-label={stopping ? "Stopping OpenCode response" : "Stop OpenCode response"}
                  aria-busy={stopping}
                >
                  <HugeiconsIcon icon={SquareStopIcon} aria-hidden="true" className="size-3.5" />
                  {stopping ? "Stopping…" : "Stop"}
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  variant="default"
                  size="icon-sm"
                  disabled={!draft.trim() || active}
                  aria-label="Send message"
                >
                  <HugeiconsIcon icon={ArrowUp01Icon} aria-hidden="true" />
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
        </form>
        {error ? (
          <p role="alert" className="mx-auto mt-2 max-w-3xl text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {conversation.status === "blocked" &&
        !conversation.approvals?.length &&
        !conversation.forms?.length ? (
          <p className="mx-auto mt-2 max-w-3xl text-xs text-muted-foreground">
            OpenCode is waiting for a permission or form response. Continue in OpenCode.
          </p>
        ) : null}
        {conversation.status === "incomplete" ? (
          <p className="mx-auto mt-2 max-w-3xl text-xs text-muted-foreground">
            The last turn did not finish. Your transcript is preserved.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function NativeFormCard({
  form,
  disabled,
  onSubmit,
}: {
  form: ConversationForm;
  disabled: boolean;
  onSubmit: (answer: Record<string, string | number | boolean>) => void;
}) {
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const answer: Record<string, string | number | boolean> = {};
    for (const field of form.fields) {
      const value = data.get(field.key);
      if (value === null || value === "") continue;
      answer[field.key] =
        field.type === "boolean"
          ? value === "true"
          : field.type === "number" || field.type === "integer"
            ? Number(value)
            : String(value);
    }
    onSubmit(answer);
  }

  return (
    <section className="mx-3 max-w-full rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{form.title || "OpenCode needs your input"}</h2>
      {form.unsupported.length ? (
        <div role="status" className="mt-3 text-sm text-muted-foreground">
          <p>This native form has fields Eden cannot safely answer yet. Continue in OpenCode.</p>
          <ul className="mt-1 list-disc pl-5">
            {form.unsupported.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : (
        <form className="mt-3 space-y-4" onSubmit={submit}>
          {form.fields.map((field) => (
            <label key={field.key} className="block space-y-1.5 text-sm">
              <span className="font-medium">
                {field.title ?? field.key}
                {field.required ? " *" : ""}
              </span>
              {field.description ? (
                <span className="block text-xs text-muted-foreground">{field.description}</span>
              ) : null}
              {field.type === "boolean" || field.options ? (
                <select
                  name={field.key}
                  required={field.required}
                  disabled={disabled}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  defaultValue=""
                >
                  <option value="">Choose…</option>
                  {field.type === "boolean" ? (
                    <>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </>
                  ) : (
                    field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))
                  )}
                </select>
              ) : (
                <Input
                  name={field.key}
                  type={field.type === "string" ? "text" : "number"}
                  placeholder={field.placeholder}
                  required={field.required}
                  disabled={disabled}
                  min={field.minimum}
                  max={field.maximum}
                  minLength={field.minLength}
                  maxLength={field.maxLength ?? 16_000}
                  step={field.type === "integer" ? 1 : "any"}
                  autoComplete="off"
                />
              )}
            </label>
          ))}
          <Button type="submit" size="sm" disabled={disabled}>
            {disabled ? "Submitting…" : "Submit answers"}
          </Button>
        </form>
      )}
    </section>
  );
}
