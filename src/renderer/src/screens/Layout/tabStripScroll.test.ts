import { describe, expect, it } from "vitest";
import {
  canScroll,
  LINE_HEIGHT_PX,
  PAGE_WIDTH_PX,
  scrollToReveal,
  wheelScrollDelta,
} from "./tabStripScroll";

describe("смещение по колесу", () => {
  it("обычная мышь крутит по вертикали — едем вбок", () => {
    expect(wheelScrollDelta(120, 0)).toBe(120);
    expect(wheelScrollDelta(-120, 0)).toBe(-120);
  });

  it("у трекпада берём горизонтальное смещение", () => {
    expect(wheelScrollDelta(4, -60)).toBe(-60);
  });

  it("когда оба есть, побеждает большее", () => {
    expect(wheelScrollDelta(100, -10)).toBe(100);
    expect(wheelScrollDelta(10, -100)).toBe(-100);
  });

  it("пересчитывает строки и страницы в пиксели", () => {
    // Без пересчёта полоса ползла бы по три пикселя за щелчок: браузер
    // отдаёт смещение в строках для многих мышей.
    expect(wheelScrollDelta(3, 0, 1)).toBe(3 * LINE_HEIGHT_PX);
    expect(wheelScrollDelta(1, 0, 2)).toBe(PAGE_WIDTH_PX);
  });
});

describe("есть ли куда прокручивать", () => {
  it("вкладки не помещаются — да", () => {
    expect(canScroll(900, 500)).toBe(true);
  });

  it("помещаются — нет", () => {
    expect(canScroll(500, 500)).toBe(false);
    // Дробный пиксель от масштабирования не считаем переполнением.
    expect(canScroll(500.5, 500)).toBe(false);
  });
});

describe("показать вкладку целиком", () => {
  it("вкладка левее видимого — подвигаем влево", () => {
    expect(scrollToReveal(100, 160, 300, 500)).toBe(76);
  });

  it("вкладка правее видимого — подвигаем вправо", () => {
    expect(scrollToReveal(700, 160, 0, 500)).toBe(384);
  });

  it("вкладка уже видна — не трогаем", () => {
    expect(scrollToReveal(200, 160, 100, 500)).toBeNull();
  });

  it("не уезжаем за левый край", () => {
    expect(scrollToReveal(5, 160, 100, 500)).toBe(0);
  });
});
