import type { OpenCodeConversationClient } from "../../../src/external/opencode/client";
import type { ConversationForm, ConversationFormField } from "../conversation-contract";

type NativeFormField = Awaited<
  ReturnType<OpenCodeConversationClient["forms"]>
>[number]["fields"][number];

export function presentForm(
  form: Awaited<ReturnType<OpenCodeConversationClient["forms"]>>[number],
): ConversationForm {
  const unsupported: string[] = [];
  const keys = form.fields.map((field) => field.key);
  const duplicateKeys = new Set(keys.filter((key, index) => keys.indexOf(key) !== index));
  const fields = form.fields.map((field): ConversationFormField => {
    const reason = unsupportedFieldReason(field, duplicateKeys);
    if (reason) unsupported.push(`${field.title ?? field.key}: ${reason}`);
    if (!isSupportedFieldType(field.type)) {
      unsupported.push(`${field.key}: unsupported field type`);
      return { key: field.key, type: "string" };
    }
    return presentField(field);
  });
  return { id: form.id, title: form.title, fields, unsupported };
}

export function validateFormAnswer(form: ConversationForm, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid form answer: submit answers as an object.");
  const answer = { ...(value as Record<string, unknown>) };
  const fields = new Map(form.fields.map((field) => [field.key, field]));
  if (Object.keys(answer).some((key) => !fields.has(key)))
    throw new Error("Invalid form answer: an unknown field was included.");
  for (const field of form.fields) validateFieldAnswer(field, answer);
  return answer as Record<string, string | number | boolean>;
}

function unsupportedFieldReason(field: NativeFormField, duplicateKeys: Set<string>) {
  return (
    invalidFieldKey(field, duplicateKeys) ??
    unsupportedVisibility(field) ??
    unsupportedNativeType(field) ??
    unsupportedStringField(field) ??
    unsupportedNumericField(field)
  );
}

function invalidFieldKey(field: NativeFormField, duplicateKeys: Set<string>) {
  return !field.key || duplicateKeys.has(field.key)
    ? "field keys must be unique and non-empty"
    : null;
}

function unsupportedVisibility(field: NativeFormField) {
  return ("hidden" in field && field.hidden) || ("when" in field && field.when?.length)
    ? "conditional or hidden fields are not supported"
    : null;
}

function unsupportedNativeType(field: NativeFormField) {
  if (field.type === "external") return "external fields are not supported";
  if (field.type === "multiselect") return "multiple-choice fields are not supported";
  return null;
}

function unsupportedStringField(field: NativeFormField) {
  if (field.type !== "string") return null;
  if (field.format || field.pattern || field.custom)
    return "formatted, patterned, or custom text fields are not supported";
  if (!validTextLimits(field)) return "text length limits are invalid";
  if (!validOptions(field.options)) return "this choice list is not supported";
  return null;
}

function unsupportedNumericField(field: NativeFormField) {
  return (field.type === "integer" || field.type === "number") &&
    !validNumericBounds(field.minimum, field.maximum)
    ? "numeric bounds are invalid or non-finite"
    : null;
}

function isSupportedFieldType(type: string): type is ConversationFormField["type"] {
  return type === "string" || type === "number" || type === "integer" || type === "boolean";
}

function presentField(field: NativeFormField): ConversationFormField {
  return {
    key: field.key,
    type: field.type as ConversationFormField["type"],
    ...presentFieldLabels(field),
    ...(field.type === "string" ? presentStringField(field) : {}),
    ...(field.type === "number" || field.type === "integer" ? presentNumberField(field) : {}),
  };
}

function presentFieldLabels(field: NativeFormField) {
  return {
    ...("title" in field && field.title ? { title: field.title } : {}),
    ...("description" in field && field.description ? { description: field.description } : {}),
    ...("required" in field && field.required ? { required: true } : {}),
  };
}

function presentStringField(field: Extract<NativeFormField, { type: "string" }>) {
  return {
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
    ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
    ...(field.options ? { options: field.options.map(presentOption) } : {}),
  };
}

function presentOption(option: { value: string; label: string; description?: string }) {
  return {
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  };
}

function presentNumberField(field: Extract<NativeFormField, { type: "number" | "integer" }>) {
  return {
    ...(finiteBound(field.minimum) ? { minimum: field.minimum } : {}),
    ...(finiteBound(field.maximum) ? { maximum: field.maximum } : {}),
  };
}

function validTextLimits(field: { minLength?: number; maxLength?: number }) {
  return !(
    (field.minLength !== undefined &&
      (!Number.isSafeInteger(field.minLength) ||
        field.minLength < 0 ||
        field.minLength > 16_000)) ||
    (field.maxLength !== undefined &&
      (!Number.isSafeInteger(field.maxLength) ||
        field.maxLength < 0 ||
        field.maxLength > 16_000)) ||
    (field.minLength !== undefined &&
      field.maxLength !== undefined &&
      field.minLength > field.maxLength)
  );
}

function validOptions(options: { value: string }[] | undefined) {
  return (
    !options ||
    (options.length > 0 &&
      options.length <= 100 &&
      new Set(options.map(({ value }) => value)).size === options.length)
  );
}

function validNumericBounds(minimum: unknown, maximum: unknown) {
  return (
    (minimum === undefined || finiteBound(minimum)) &&
    (maximum === undefined || finiteBound(maximum)) &&
    !(finiteBound(minimum) && finiteBound(maximum) && minimum > maximum)
  );
}

function finiteBound(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateFieldAnswer(field: ConversationFormField, answer: Record<string, unknown>) {
  const entry = answer[field.key];
  if (entry === undefined || entry === "") {
    if (field.required)
      throw new Error(`Invalid form answer: ${field.title ?? field.key} is required.`);
    delete answer[field.key];
    return;
  }
  if (field.type === "boolean") return validateBoolean(field, entry);
  if (field.type === "number" || field.type === "integer") return validateNumber(field, entry);
  validateString(field, entry);
}

function validateBoolean(field: ConversationFormField, entry: unknown) {
  if (typeof entry !== "boolean")
    throw new Error(`Invalid form answer: ${field.title ?? field.key} must be true or false.`);
}

function validateNumber(field: ConversationFormField, entry: unknown) {
  if (
    typeof entry !== "number" ||
    !Number.isFinite(entry) ||
    (field.type === "integer" && !Number.isInteger(entry)) ||
    (field.minimum !== undefined && entry < field.minimum) ||
    (field.maximum !== undefined && entry > field.maximum)
  )
    throw new Error(
      `Invalid form answer: ${field.title ?? field.key} is outside its allowed range.`,
    );
}

function validateString(field: ConversationFormField, entry: unknown) {
  if (
    typeof entry !== "string" ||
    (field.minLength !== undefined && entry.length < field.minLength) ||
    (field.maxLength !== undefined && entry.length > field.maxLength) ||
    entry.length > 16_000 ||
    (field.options && !field.options.some((option) => option.value === entry))
  )
    throw new Error(`Invalid form answer: ${field.title ?? field.key} is not a valid choice.`);
}
