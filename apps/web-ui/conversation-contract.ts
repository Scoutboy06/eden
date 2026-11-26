export type ConversationMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  tools?: {
    id: string;
    name: string;
    status: "running" | "completed" | "failed";
  }[];
};

export type ConversationStatus = "ready" | "active" | "blocked" | "incomplete";

export type ConversationFormField = {
  key: string;
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  options?: { value: string; label: string; description?: string }[];
};

export type ConversationForm = {
  id: string;
  title: string;
  fields: ConversationFormField[];
  unsupported: string[];
};

export type Conversation = {
  id: string;
  project: string;
  worktree: string;
  branch: string | null;
  hidden: boolean;
  status: ConversationStatus;
  selectedModelKey: string | null;
  selectedModelLabel: string | null;
  messages: ConversationMessage[];
  approvals?: {
    id: string;
    action: string;
    resources: string[];
    message?: string;
  }[];
  forms?: ConversationForm[];
  updatedAt: number;
};
