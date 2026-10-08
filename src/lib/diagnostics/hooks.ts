/*
 * Which structure hook describes a file (original TRACE module, MIT). A board adapter carries its own hook as the optional
 * `structure` member (src/lib/formats/structure-hook.ts); an adapter without one is reported with its detection and result facts
 * only. A file no adapter claims is described by a generic hook: the union of the public keywords of every registered hook for
 * text, nothing for binary data (its input facts say all there is to say).
 */
import type { BoardAdapter } from '../formats/adapter';
import type { StructureHook } from '../formats/structure-hook';
import { genericTextHook } from './hooks-text';
import { genericBinaryHook } from './hooks-binary';

const generic = new WeakMap<readonly BoardAdapter[], StructureHook>();

/** The hook for a file no adapter claimed (or whose adapter has none). */
export function genericHookFor(adapters: readonly BoardAdapter[], textLike: boolean): StructureHook {
  if (!textLike) return genericBinaryHook;
  let hook = generic.get(adapters);
  if (!hook) {
    hook = genericTextHook([...new Set(adapters.flatMap(adapter => adapter.structure?.keywords ?? []))]);
    generic.set(adapters, hook);
  }
  return hook;
}
