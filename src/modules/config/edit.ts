import { CST, isMap, isScalar, parseDocument, stringify, type Scalar, type YAMLMap } from "yaml";

export class ConfigYamlEditor {
  private readonly source: string;
  private readonly document: ReturnType<typeof parseDocument> | undefined;

  constructor(source: string | undefined) {
    this.source = source ?? "";
    this.document = source === undefined ? undefined : this.parseDocument(source);
  }

  set(keys: string[], value: string): string {
    if (!this.document) return stringify(this.nestSetting(keys, value));

    const existing = this.document.getIn(keys, true);

    if (isScalar(existing) && existing.srcToken && existing.range) {
      return this.replaceScalar(existing, value);
    }

    return this.insertMissingSetting(keys, value);
  }

  private parseDocument(source: string) {
    const document = parseDocument(source, { keepSourceTokens: true });

    if (document.errors.length > 0) throw new Error("Configuration YAML could not be edited");

    return document;
  }

  private replaceScalar(scalar: Scalar, value: string): string {
    if (!scalar.srcToken || !scalar.range)
      throw new Error("Configuration scalar has no source range");

    CST.setScalarValue(scalar.srcToken, value, { inFlow: true, type: scalar.type });

    return this.replaceSource(scalar.range[0], scalar.range[2], CST.stringify(scalar.srcToken));
  }

  private insertMissingSetting(keys: string[], value: string): string {
    for (let depth = keys.length - 1; depth >= 0; depth--) {
      const parent = this.document?.getIn(keys.slice(0, depth), true);

      if (isMap(parent)) {
        const setting = this.nestSetting(keys.slice(depth), value);

        return this.insertIntoMapping(parent, setting);
      }
    }

    throw new Error("Configuration YAML does not contain an editable mapping");
  }

  private insertIntoMapping(mapping: YAMLMap, setting: unknown): string {
    if (!mapping.range || !mapping.srcToken) {
      throw new Error("Configuration mapping has no source range");
    }

    if (mapping.flow) return this.insertIntoFlowMapping(mapping, setting);

    if (mapping.srcToken.type !== "block-map") {
      throw new Error("Configuration mapping is not editable");
    }

    return this.insertBlockSetting(mapping.range[1], mapping.srcToken.indent, setting);
  }

  private insertIntoFlowMapping(mapping: YAMLMap, setting: unknown): string {
    const closingBrace = mapping.range![1] - 1;
    const separator = this.flowSeparator(mapping);
    const contents = this.formatFlowSetting(setting);

    return this.insertSource(closingBrace, separator + contents);
  }

  private flowSeparator(mapping: YAMLMap): string {
    const [start, end] = mapping.range!;
    const contents = this.source.slice(start, end - 1).trimEnd();
    const needsComma = mapping.items.length > 0 && !contents.endsWith(",");

    return needsComma ? ", " : " ";
  }

  private formatFlowSetting(setting: unknown): string {
    const mapping = stringify(setting, { collectionStyle: "flow" }).trim();

    return mapping.slice(1, -1).trim();
  }

  private insertBlockSetting(offset: number, indent: number, setting: unknown): string {
    const contents = this.formatBlockSetting(setting, indent);
    const separator = this.lineBreakBefore(offset);

    return this.insertSource(offset, separator + contents + this.newline);
  }

  private formatBlockSetting(setting: unknown, indent: number): string {
    const indentation = " ".repeat(indent);
    const lines = stringify(setting).trimEnd().split("\n");

    return lines.map((line) => indentation + line).join(this.newline);
  }

  private lineBreakBefore(offset: number): string {
    const needsNewline = offset > 0 && this.source[offset - 1] !== "\n";

    return needsNewline ? this.newline : "";
  }

  private get newline(): string {
    return this.source.includes("\r\n") ? "\r\n" : "\n";
  }

  private nestSetting(keys: string[], value: string): unknown {
    let setting: unknown = value;

    for (const key of keys.toReversed()) setting = { [key]: setting };

    return setting;
  }

  private insertSource(offset: number, contents: string): string {
    return this.replaceSource(offset, offset, contents);
  }

  private replaceSource(start: number, end: number, contents: string): string {
    return this.source.slice(0, start) + contents + this.source.slice(end);
  }
}
