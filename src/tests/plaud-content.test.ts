import { describe, expect, it } from "vitest";
import {
    findInlineContent,
    isReady,
    parseSummary,
    parseTranscript,
    selectContentItems,
} from "@/lib/plaud/content";
import type { PlaudFileDetailResponse } from "@/types/plaud";

// These fixtures mirror a real captured `GET /file/detail` response (#204):
// `content_list` carries a `transaction` (transcript), an `outline`, and two
// summary items (`auto_sum_note` = the primary "Summary", `sum_multi_note` =
// a secondary template note). The primary summary is also delivered inline in
// `pre_download_content_list` as a JSON-string `data_content` keyed by data_id.
//
// The transcript *segment* body (the `trans_result.json.gz` behind the
// transaction `data_link`) is NOT yet captured, so the `parseTranscript`
// segment tests below still encode a hypothesized shape.

const FID = "633b0f8a6d655651d6ab69c48c79e434";
const AUTO_SUM_ID = `auto_sum:0bca96ca:${FID}`;

const inlineSummary = JSON.stringify({
    ai_content: "## Summary\n### Gist\nSpeaker 1 is heading out soon.",
    category: "Chat Note",
    summary_id: "20251119154839-v2@b7bde30dfbb8a8ff5f6136-1",
    summ_type: "CASUAL-CONVERSATION",
    header: { headline: "Travel plans", keywords: [] },
    state: 10,
});

const detail: PlaudFileDetailResponse = {
    status: 0,
    msg: "success",
    data: {
        file_id: FID,
        content_list: [
            {
                data_id: `source_transaction:0bca96ca:${FID}`,
                data_type: "transaction",
                task_status: 1,
                data_link: "https://s3.example/trans_result.json.gz",
            },
            {
                data_id: `source_outline:0bca96ca:${FID}`,
                data_type: "outline",
                task_status: 1,
                data_link: "https://s3.example/outline.json.gz",
            },
            {
                data_id: AUTO_SUM_ID,
                data_type: "auto_sum_note",
                data_title: "Summary",
                data_tab_name: "Summary",
                task_status: 1,
                data_link: "https://s3.example/ai_content_part_0.json.gz",
            },
            {
                data_id: `sum_multi:0bca96ca:${FID}:502b872d`,
                data_type: "sum_multi_note",
                data_title: "Voice Note",
                data_tab_name: "Voice Note",
                task_status: 1,
                data_link: "https://s3.example/ai_content_part_1.json.gz",
            },
        ],
        pre_download_content_list: [
            { data_id: AUTO_SUM_ID, data_content: inlineSummary },
        ],
    },
};

describe("plaud content parsers", () => {
    it("selects the transaction transcript and the primary auto_sum summary", () => {
        const { transcript, summary } = selectContentItems(detail);
        expect(transcript?.data_type).toBe("transaction");
        // Must skip `outline` and `sum_multi_note`, prefer `auto_sum_note`.
        expect(summary?.data_type).toBe("auto_sum_note");
    });

    it("selects via data_id prefix when data_type strings drift", () => {
        const drifted: PlaudFileDetailResponse = {
            status: 0,
            data: {
                content_list: [
                    {
                        data_id: `source_transaction:x:${FID}`,
                        data_type: "unknown_renamed",
                        task_status: 1,
                        data_link: "https://s3.example/t",
                    },
                    {
                        data_id: `auto_sum:x:${FID}`,
                        data_type: "weird_new_type",
                        task_status: 1,
                        data_link: "https://s3.example/s",
                    },
                ],
            },
        };
        const { transcript, summary } = selectContentItems(drifted);
        expect(transcript?.data_id).toBe(`source_transaction:x:${FID}`);
        expect(summary?.data_id).toBe(`auto_sum:x:${FID}`);
    });

    it("prefers the primary summary even when a secondary note comes first", () => {
        const reordered: PlaudFileDetailResponse = {
            status: 0,
            data: {
                content_list: [
                    {
                        data_id: "sum_multi:a:b:c",
                        data_type: "sum_multi_note",
                        task_status: 1,
                        data_link: "https://s3.example/multi",
                    },
                    {
                        data_id: "auto_sum:a:b",
                        data_type: "auto_sum_note",
                        task_status: 1,
                        data_link: "https://s3.example/auto",
                    },
                ],
            },
        };
        expect(selectContentItems(reordered).summary?.data_type).toBe(
            "auto_sum_note",
        );
    });

    it("falls back to a secondary note when no primary summary exists", () => {
        const onlyMulti: PlaudFileDetailResponse = {
            status: 0,
            data: {
                content_list: [
                    {
                        data_id: "sum_multi:a:b:c",
                        data_type: "sum_multi_note",
                        task_status: 1,
                        data_link: "https://s3.example/multi",
                    },
                ],
            },
        };
        expect(selectContentItems(onlyMulti).summary?.data_type).toBe(
            "sum_multi_note",
        );
    });

    it("returns nothing for an empty content list", () => {
        expect(selectContentItems({ status: 0, data: {} })).toEqual({});
        expect(selectContentItems({ status: 0 })).toEqual({});
    });

    it("isReady gates on task_status===1 AND a data_link", () => {
        expect(isReady({ task_status: 1, data_link: "x" })).toBe(true);
        expect(isReady({ task_status: 0, data_link: "x" })).toBe(false);
        expect(isReady({ task_status: 1 })).toBe(false);
        expect(isReady(undefined)).toBe(false);
    });

    it("finds the inline summary payload by data_id (no S3 round-trip)", () => {
        const inline = findInlineContent(detail, AUTO_SUM_ID);
        expect(parseSummary(inline).summary).toContain("## Summary");
    });

    it("returns undefined when there is no inline copy", () => {
        expect(findInlineContent(detail, "sum_multi:0bca96ca:nope")).toBe(
            undefined,
        );
        expect(findInlineContent(detail, undefined)).toBe(undefined);
    });

    it("parses summary from the real ai_content field", () => {
        expect(parseSummary({ ai_content: "The gist" }).summary).toBe(
            "The gist",
        );
    });

    it("still maps key_points / action_items when a provider sends them", () => {
        const s = parseSummary({
            summary: "S",
            key_points: ["a", "b"],
            action_items: ["do x"],
        });
        expect(s.summary).toBe("S");
        expect(s.keyPoints).toEqual(["a", "b"]);
        expect(s.actionItems).toEqual(["do x"]);
    });

    it("treats a bare string as the summary and tolerates junk", () => {
        expect(parseSummary("just text").summary).toBe("just text");
        expect(parseSummary(null)).toEqual({
            summary: "",
            keyPoints: [],
            actionItems: [],
        });
    });

    // --- transcript segment shape: still hypothesized (unverified body) ---
    it("parses a diarized transcript array into speaker-prefixed text", () => {
        const raw = [
            { start_time: 0, speaker: 1, content: "Hello there" },
            { start_time: 5, speaker: 2, content: "Hi back" },
        ];
        const parsed = parseTranscript(raw);
        expect(parsed.text).toBe("Speaker 1: Hello there\nSpeaker 2: Hi back");
        expect(parsed.segments).toHaveLength(2);
    });

    it("handles transcript objects that wrap segments and a language", () => {
        const raw = {
            language: "en",
            segments: [{ speaker: "Alice", content: "Hey" }],
        };
        const parsed = parseTranscript(raw);
        expect(parsed.language).toBe("en");
        expect(parsed.text).toBe("Alice: Hey");
    });

    it("omits a speaker label when the segment has no speaker", () => {
        expect(parseTranscript([{ content: "no speaker" }]).text).toBe(
            "no speaker",
        );
    });

    it("returns empty text for junk transcript input", () => {
        expect(parseTranscript(null).text).toBe("");
        expect(parseTranscript("").text).toBe("");
        expect(parseTranscript(42).segments).toEqual([]);
    });
});
