/**
 * Shapes of the generated struct schemas (src/generated/structs.gen.ts). A
 * schema is the decompilation's recovered layout for one C struct: every
 * field with its offset, C type and array length, in memory order.
 *
 * @portOnly schema support
 */

export type CKind = 'int' | 'uint' | 'short' | 'ushort' | 'byte' | 'sbyte' | 'char' | 'ptr' | 'struct' | 'pad';

export interface FieldSpec {
  readonly name: string;
  readonly offset: number;
  /** size of one element in bytes */
  readonly size: number;
  /** array length; 1 for a scalar */
  readonly count: number;
  readonly ctype: string;
  readonly kind: CKind;
  /** struct name for an inline struct, or a pointer to a known struct */
  readonly target?: string;
  /** named field_0x..: nothing has established what it means */
  readonly unestablished?: boolean;
}

export interface StructSchema {
  readonly name: string;
  readonly size: number;
  readonly fields: readonly FieldSpec[];
}

export interface GlobalSpec {
  readonly name: string;
  readonly ctype: string;
  readonly address: number;
  readonly count: number;
}
