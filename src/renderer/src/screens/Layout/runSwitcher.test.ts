import { describe, expect, it } from "vitest";
import {
  advance,
  neighbourRunId,
  openSwitcher,
  runIdAtPosition,
  switcherLabel,
  type SwitcherItem,
  tabOrder,
} from "./runSwitcher";

const items = (...ids: string[]): SwitcherItem[] =>
  ids.map((id) => ({ id, title: id.toUpperCase() }));

describe("tabOrder", () => {
  it("ставит диалоги перед разделами, как рисует полоса", () => {
    expect(tabOrder(["r1", "r2"], ["notes", "kanban"])).toEqual([
      "r1",
      "r2",
      "notes",
      "kanban",
    ]);
  });

  it("работает, когда разделов нет", () => {
    expect(tabOrder(["r1"], [])).toEqual(["r1"]);
  });

  it("работает, когда нет ни того ни другого", () => {
    expect(tabOrder([], [])).toEqual([]);
  });
});

describe("стрелки по всем вкладкам", () => {
  const tabs = tabOrder(["r1", "r2"], ["notes", "staff"]);

  it("из последнего диалога уходят в первый раздел, а не по кругу диалогов", () => {
    // Ровно та жалоба: раньше список состоял из одних диалогов, и стрелка с
    // «r2» возвращалась на «r1», минуя открытые разделы.
    expect(neighbourRunId(tabs, "r2")).toBe("notes");
  });

  it("из первого раздела назад возвращаются в последний диалог", () => {
    expect(neighbourRunId(tabs, "notes", true)).toBe("r2");
  });

  it("с последнего раздела по кругу уходят в первый диалог", () => {
    expect(neighbourRunId(tabs, "staff")).toBe("r1");
  });

  it("цифрой добираются и до раздела", () => {
    expect(runIdAtPosition(tabs, 3)).toBe("notes");
  });
});

describe("runIdAtPosition", () => {
  it("берёт вкладку по её месту в верхней строке", () => {
    expect(runIdAtPosition(["a", "b", "c"], 2)).toBe("b");
  });

  it("ничего не делает, когда вкладок меньше", () => {
    expect(runIdAtPosition(["a"], 3)).toBe(null);
  });

  it("дальше девятой по цифрам не ходит", () => {
    const many = Array.from({ length: 12 }, (_, i) => `r${i + 1}`);
    expect(runIdAtPosition(many, 9)).toBe("r9");
    expect(runIdAtPosition(many, 10)).toBe(null);
  });
});

describe("neighbourRunId", () => {
  it("идёт к следующей вкладке", () => {
    expect(neighbourRunId(["a", "b", "c"], "a")).toBe("b");
  });

  it("с последней возвращается на первую", () => {
    expect(neighbourRunId(["a", "b", "c"], "c")).toBe("a");
  });

  it("с первой назад уходит на последнюю", () => {
    expect(neighbourRunId(["a", "b", "c"], "a", true)).toBe("c");
  });

  it("одна вкладка — остаёмся на ней", () => {
    expect(neighbourRunId(["a"], "a")).toBe("a");
  });
});

describe("openSwitcher", () => {
  it("начинает со следующего за текущим диалогом", () => {
    const state = openSwitcher(items("a", "b", "c"), "a");
    expect(state?.items[state.index].id).toBe("b");
  });

  it("с Shift идёт к предыдущему", () => {
    const state = openSwitcher(items("a", "b", "c"), "a", true);
    expect(state?.items[state.index].id).toBe("c");
  });

  it("если текущего в списке нет, начинает с начала", () => {
    const state = openSwitcher(items("a", "b"), "zzz");
    expect(state?.items[state.index].id).toBe("a");
  });

  it("не открывается, когда переключаться не на что", () => {
    expect(openSwitcher(items("a"), "a")).toBe(null);
  });

  it("показывает не больше десяти", () => {
    const many = items(...Array.from({ length: 14 }, (_, i) => `s${i}`));
    expect(openSwitcher(many, "s0")?.items).toHaveLength(10);
  });
});

describe("advance", () => {
  it("идёт по кругу вперёд и назад", () => {
    const state = { items: items("a", "b", "c"), index: 2 };
    expect(advance(state).index).toBe(0);
    expect(advance(state, true).index).toBe(1);
  });
});

describe("switcherLabel", () => {
  it("подставляет запасную подпись безымянному диалогу", () => {
    expect(switcherLabel({ id: "a", title: "  " }, "Новый чат")).toBe(
      "Новый чат",
    );
  });
});
