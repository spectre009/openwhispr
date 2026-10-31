// The everyday words auto-learn never learns (correctionLearner.js): swapping
// one for another ("why" -> "what") is a content edit, not vocabulary, and
// learning it would only pad the cleanup prompt. Tidy up's "Ordinary words"
// flags any dictionary word on this list, whatever History says. ESM shared by
// main (via require) and the renderer. Words under three letters are dropped
// before the list is consulted, so none are listed here.

export const CORRECTION_COMMON_WORDS = Object.freeze(
  `the and for not with you this but his from they say her she will one all would
  there their what out about who get which when make can like time just him know
  take into year your good some could them see other than then now look only come
  over think also back after use two how our work first well way even new want
  because any these give day most are was were been has had did does said went
  made got came took saw knew thought where why here very much many still too again
  off down never every own same another both each few more less last next while
  before through under between should might must being have that its yes okay`
    .split(/\s+/)
    .filter(Boolean)
);
