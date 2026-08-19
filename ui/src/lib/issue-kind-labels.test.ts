import { describe, expect, it } from "vitest";
import type { IssueLabel } from "@paperclipai/shared";
import { findKindLabel, issueHasKind, nextLabelIdsForKinds } from "./issue-kind-labels";

function label(id: string, name: string): IssueLabel {
  return {
    id,
    companyId: "company-1",
    name,
    color: "#000000",
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
    updatedAt: new Date("2026-08-19T00:00:00.000Z"),
  };
}

const catalog = [label("bug-1", "Bug"), label("hf-1", "hotfix"), label("other-1", "infra")];

describe("issue-kind-labels", () => {
  it("matches kind labels case-insensitively", () => {
    expect(findKindLabel(catalog, "bug")?.id).toBe("bug-1");
    expect(findKindLabel(catalog, "hotfix")?.id).toBe("hf-1");
  });

  it("detects kind from labelIds or embedded labels", () => {
    expect(issueHasKind({ labelIds: ["bug-1"] }, "bug", catalog)).toBe(true);
    expect(issueHasKind({ labels: [label("hf-1", "hotfix")] }, "hotfix", catalog)).toBe(true);
    expect(issueHasKind({ labelIds: ["other-1"] }, "bug", catalog)).toBe(false);
  });

  it("keeps unrelated labels and forces bug when hotfix is on", () => {
    expect(nextLabelIdsForKinds({
      labelIds: ["other-1"],
      catalog,
      bug: false,
      hotfix: true,
    })).toEqual(["other-1", "bug-1", "hf-1"]);
  });

  it("clears hotfix without dropping an explicit bug", () => {
    expect(nextLabelIdsForKinds({
      labelIds: ["other-1", "bug-1", "hf-1"],
      catalog,
      bug: true,
      hotfix: false,
    })).toEqual(["other-1", "bug-1"]);
  });
});
