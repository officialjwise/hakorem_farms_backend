/** A rule a livestock record breaks, with the JSON pointer of the field that breaks it. */
export interface LivRuleBroken {
  readonly field: string;
  readonly rule: string;
}
