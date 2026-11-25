import { useEffect, useRef, useState } from "react";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Message, MessageContent, MessageGroup } from "@/components/ui/message";
import {
  sendConversationMessage,
  replyToPermission,
  stopConversation,
  type Conversation,
} from "@/pages/conversations";
import { Streamdown } from "streamdown";

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
  const [error, setError] = useState<string | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lastMessage = conversation.messages.at(-1);
  const approvalsKey = conversation.approvals?.map(({ id }) => id).join(",");
  const active = conversation.status === "active" || conversation.status === "blocked" || sending;

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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || active) return;
    setSending(true);
    setError(null);
    try {
      await sendConversationMessage(conversation.id, text);
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
                    <Streamdown
                      className="px-3 py-2 text-sm leading-relaxed"
                      isAnimating={conversation.status === "active"}
                    >
                      {message.text}
                    </Streamdown>
                  )}
                </MessageContent>
              </Message>
            ))}
            {active && !(conversation.status === "blocked" && conversation.approvals?.length) ? (
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
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              className="min-h-14 p-3"
            />
            <InputGroupAddon align="block-end" className="justify-end">
              {conversation.status === "active" || conversation.status === "blocked" ? (
                <InputGroupButton
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={stopping}
                  onClick={() => void stop()}
                >
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
                  ↑
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
        {conversation.status === "blocked" && !conversation.approvals?.length ? (
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
