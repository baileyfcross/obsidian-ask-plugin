import { OllamaClient } from "../ollama/OllamaClient";
import { KnowledgeIndex } from "../search/KnowledgeIndex";
import { LocalVaultAISettings } from "../settings/Settings";
import { RetrievedChunk } from "../types";

export interface LectureRequest {
  topic: string;
  audience: string;
  durationMinutes: number;
  targetSlides: number;
  includeExamples: boolean;
  includeExercises: boolean;
  includeSpeakerNotes: boolean;
}

export interface LectureSlide {
  number: number;

  title: string;

  type:
    | "title"
    | "objectives"
    | "content"
    | "example"
    | "exercise"
    | "review";

  bullets: string[];

  speakerNotes: string;

  sourceNumbers: number[];
}

export interface LectureResult {
  title: string;
  audience: string;
  durationMinutes: number;
  slides: LectureSlide[];
  sources: RetrievedChunk[];
}

interface LectureModelResponse {
  title: string;
  audience: string;
  durationMinutes: number;
  slides: LectureSlide[];
}

export class LectureService {
  constructor(
    private readonly ollama: OllamaClient,
    private readonly index: KnowledgeIndex,
    private readonly settings: LocalVaultAISettings,
  ) {}

  async generate(
    request: LectureRequest,
  ): Promise<LectureResult> {
    if (!this.index.isReady()) {
      throw new Error(
        "The knowledge index is not ready. Rebuild the index first.",
      );
    }

    const retrievalQuery = [
      request.topic,
      request.audience,
      "lecture",
      "definitions",
      "concepts",
      "examples",
      "prerequisites",
      "applications",
      "exercises",
    ].join(" ");

    const embeddings =
      await this.ollama.embed(
        this.settings.embeddingModel,
        [retrievalQuery],
      );

    const queryVector = embeddings[0];

    if (!queryVector) {
      throw new Error(
        "Could not create the lecture retrieval embedding.",
      );
    }

    /*
     * Lecture generation intentionally retrieves
     * substantially more material than normal chat.
     */
    const sources =
      await this.index.hybridSearch(
        retrievalQuery,
        queryVector,
        {
          limit: 30,
          textWeight:
            this.settings.hybridTextWeight,
          vectorWeight:
            this.settings.hybridVectorWeight,
          similarity:
            this.settings.minVectorSimilarity,
        },
      );

    if (sources.length === 0) {
      throw new Error(
        `No vault material was found for "${request.topic}".`,
      );
    }

    const context = this.buildContext(sources);

    const systemPrompt =
      this.buildSystemPrompt(request);

    const userPrompt =
      this.buildUserPrompt(
        request,
        context,
      );

    /*
     * Important:
     *
     * Normal chat uses settings.chatModel.
     * Lecture generation uses settings.lectureModel.
     */
    const response =
      await this.ollama.chat(
        this.settings.lectureModel,
        [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
      );

    const parsed =
      this.parseLectureResponse(response);

    return {
      ...parsed,
      sources,
    };
  }

  private buildContext(
    sources: RetrievedChunk[],
  ): string {
    return sources
      .map((source, index) =>
        [
          `[SOURCE ${index + 1}]`,
          `File: ${source.filePath}`,
          `Title: ${source.title}`,
          `Section: ${source.heading}`,
          `Tags: ${
            source.tags.length > 0
              ? source.tags.join(", ")
              : "(none)"
          }`,
          "",
          source.content,
        ].join("\n"),
      )
      .join(
        "\n\n------------------------------\n\n",
      );
  }

  private buildSystemPrompt(
    request: LectureRequest,
  ): string {
    return [
      "You are an expert college instructor and instructional designer.",
      "",
      "Your task is to transform information from the user's Obsidian Zettelkasten into a coherent lecture slide deck.",
      "",
      `Audience: ${request.audience}`,
      "",
      "Instructional principles:",
      "- Establish prerequisite concepts before dependent concepts.",
      "- Introduce one major idea at a time.",
      "- Explain why concepts matter.",
      "- Use concrete examples when requested.",
      "- Prefer 3-5 concise bullets on normal content slides.",
      "- Put detailed explanations in speaker notes rather than overcrowding slides.",
      "- Include logical transitions between concepts.",
      "- Include exercises when requested.",
      "- End with a concise review of major concepts.",
      "",
      "Vault grounding rules:",
      "- Base factual lecture content on the supplied vault sources.",
      "- Do not invent claims and attribute them to the user's notes.",
      "- Track which source numbers support each slide.",
      "- Never invent source numbers.",
      "",
      "Output rules:",
      "- Return valid JSON only.",
      "- Do not use Markdown code fences.",
      "- Do not include commentary before or after the JSON.",
    ].join("\n");
  }

  private buildUserPrompt(
    request: LectureRequest,
    context: string,
  ): string {
    return [
      "CREATE LECTURE",
      "",
      `Topic: ${request.topic}`,
      `Audience: ${request.audience}`,
      `Duration: ${request.durationMinutes} minutes`,
      `Target slides: ${request.targetSlides}`,
      `Include examples: ${request.includeExamples}`,
      `Include exercises: ${request.includeExercises}`,
      `Include speaker notes: ${request.includeSpeakerNotes}`,
      "",
      "Return JSON in this structure:",
      "",
      "{",
      '  "title": "Lecture title",',
      `  "audience": ${JSON.stringify(request.audience)},`,
      `  "durationMinutes": ${request.durationMinutes},`,
      '  "slides": [',
      "    {",
      '      "number": 1,',
      '      "title": "Slide title",',
      '      "type": "title",',
      '      "bullets": [],',
      '      "speakerNotes": "",',
      '      "sourceNumbers": []',
      "    }",
      "  ]",
      "}",
      "",
      "VAULT MATERIAL",
      "",
      context,
    ].join("\n");
  }

  private parseLectureResponse(
    response: string,
  ): LectureModelResponse {
    let parsed: unknown;

    try {
      parsed = JSON.parse(
        this.cleanJsonResponse(response),
      );
    } catch {
      throw new Error(
        "The lecture model did not return valid JSON.",
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null
    ) {
      throw new Error(
        "The lecture model returned an invalid lecture structure.",
      );
    }

    const candidate =
      parsed as Partial<LectureModelResponse>;

    if (
      typeof candidate.title !== "string" ||
      typeof candidate.audience !== "string" ||
      typeof candidate.durationMinutes !== "number" ||
      !Array.isArray(candidate.slides)
    ) {
      throw new Error(
        "The lecture model response is missing required fields.",
      );
    }

    return {
      title: candidate.title,
      audience: candidate.audience,
      durationMinutes:
        candidate.durationMinutes,
      slides: candidate.slides,
    };
  }

  private cleanJsonResponse(
    response: string,
  ): string {
    let cleaned = response.trim();

    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.slice(7);
    } else if (
      cleaned.startsWith("```")
    ) {
      cleaned = cleaned.slice(3);
    }

    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(
        0,
        -3,
      );
    }

    return cleaned.trim();
  }
}
