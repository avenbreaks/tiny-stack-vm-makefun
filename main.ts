// Tiny stack VM for make.fun's tiny-stack-vm-01 bounty.
// Runs every program.bin in /input/<id>/ against its input.bin and writes
// /output/<id>/stdout.bin and /output/<id>/exit.txt, per the ISA in the kit.
// Written from the ISA spec alone: 32-bit wrapping ints, 256-value data stack,
// 64-deep call stack, 256 words of memory, ten traps, 1,000,000-step limit.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Opcode info: [values popped, values pushed, immediate length in bytes].
// Keys are the opcode bytes from the ISA table.
const INFO: Record<number, [number, number, number]> = {
  0x00: [0, 0, 0], 0x01: [0, 1, 1], 0x02: [0, 1, 4], 0x03: [1, 0, 0],
  0x04: [1, 2, 0], 0x05: [2, 2, 0], 0x06: [2, 3, 0], 0x07: [3, 3, 0],
  0x10: [2, 1, 0], 0x11: [2, 1, 0], 0x12: [2, 1, 0], 0x13: [2, 1, 0],
  0x14: [2, 1, 0], 0x15: [2, 1, 0], 0x16: [2, 1, 0], 0x17: [1, 1, 0],
  0x18: [2, 1, 0], 0x19: [2, 1, 0], 0x1a: [2, 1, 0], 0x1b: [1, 1, 0],
  0x1c: [2, 1, 0], 0x1d: [2, 1, 0], 0x1e: [2, 1, 0],
  0x20: [2, 1, 0], 0x21: [2, 1, 0], 0x22: [2, 1, 0],
  0x30: [0, 0, 2], 0x31: [1, 0, 2], 0x32: [1, 0, 2], 0x33: [0, 0, 2],
  0x34: [0, 0, 0],
  0x40: [1, 1, 0], 0x41: [2, 0, 0],
  0x50: [1, 0, 0], 0x51: [1, 0, 0], 0x52: [0, 1, 0], 0x53: [1, 0, 0],
};

function runVm(prog: Uint8Array, input: Uint8Array): { out: Buffer; exit: number } {
  const stack = new Int32Array(256);
  const calls = new Int32Array(64);
  const mem = new Int32Array(256);
  const out: number[] = [];
  let sp = 0; // data stack depth
  let cp = 0; // call stack depth
  let pc = 0;
  let steps = 0;
  let inPos = 0;

  const finish = (code: number) => ({ out: Buffer.from(out), exit: code });

  for (;;) {
    // 1. Step limit, checked before fetching the next instruction.
    if (steps >= 1000000) return finish(10);
    // 2. pc outside the program.
    if (pc < 0 || pc >= prog.length) return finish(9);
    const op = prog[pc];
    const info = INFO[op];
    // 3. Unknown opcode.
    if (!info) return finish(5);
    const [pops, pushes, immLen] = info;
    // 4. Immediate cut off by the end of the program.
    if (pc + 1 + immLen > prog.length) return finish(9);
    // 5. Stack needs first: underflow, then overflow.
    if (sp < pops) return finish(2);
    if (sp - pops + pushes > 256) return finish(3);
    steps++;

    let next = pc + 1 + immLen;
    const a = stack[sp - 2];
    const b = stack[sp - 1];
    switch (op) {
      case 0x00: return finish(0); // HALT
      case 0x01: { // PUSH8, sign-extended
        const v = prog[pc + 1];
        stack[sp++] = v >= 128 ? v - 256 : v;
        break;
      }
      case 0x02: // PUSH32, little-endian signed
        stack[sp++] = prog[pc + 1] | (prog[pc + 2] << 8) | (prog[pc + 3] << 16) | (prog[pc + 4] << 24);
        break;
      case 0x03: sp--; break; // POP
      case 0x04: stack[sp] = b; sp++; break; // DUP
      case 0x05: stack[sp - 2] = b; stack[sp - 1] = a; break; // SWAP
      case 0x06: stack[sp] = a; sp++; break; // OVER
      case 0x07: { const x = stack[sp - 3]; stack[sp - 3] = a; stack[sp - 2] = b; stack[sp - 1] = x; break; } // ROT (a b c -- b c a)
      case 0x10: stack[sp - 2] = (a + b) | 0; sp--; break; // ADD, wraps
      case 0x11: stack[sp - 2] = (a - b) | 0; sp--; break; // SUB
      case 0x12: stack[sp - 2] = Math.imul(a, b); sp--; break; // MUL, low 32 bits
      case 0x13: // DIV, truncated toward zero; INT_MIN / -1 wraps to INT_MIN
        if (b === 0) return finish(4);
        stack[sp - 2] = (a / b) | 0; sp--; break;
      case 0x14: // MOD, sign of a; x % -1 is 0
        if (b === 0) return finish(4);
        stack[sp - 2] = (a % b) | 0; sp--; break;
      case 0x15: // DIVU, unsigned
        if (b === 0) return finish(4);
        stack[sp - 2] = Math.floor((a >>> 0) / (b >>> 0)) | 0; sp--; break;
      case 0x16: // MODU, unsigned
        if (b === 0) return finish(4);
        stack[sp - 2] = ((a >>> 0) % (b >>> 0)) | 0; sp--; break;
      case 0x17: stack[sp - 1] = (-b) | 0; break; // NEG
      case 0x18: stack[sp - 2] = a & b; sp--; break; // AND
      case 0x19: stack[sp - 2] = a | b; sp--; break; // OR
      case 0x1a: stack[sp - 2] = a ^ b; sp--; break; // XOR
      case 0x1b: stack[sp - 1] = ~b; break; // NOT
      case 0x1c: stack[sp - 2] = a << (b & 31); sp--; break; // SHL
      case 0x1d: stack[sp - 2] = a >> (b & 31); sp--; break; // SHR, arithmetic
      case 0x1e: stack[sp - 2] = (a >>> (b & 31)) | 0; sp--; break; // SHRU, logical
      case 0x20: stack[sp - 2] = a === b ? 1 : 0; sp--; break; // EQ
      case 0x21: stack[sp - 2] = a < b ? 1 : 0; sp--; break; // LT, signed
      case 0x22: stack[sp - 2] = (a >>> 0) < (b >>> 0) ? 1 : 0; sp--; break; // LTU
      case 0x30: { // JMP, signed 16-bit offset from the next instruction
        let off = prog[pc + 1] | (prog[pc + 2] << 8);
        if (off >= 32768) off -= 65536;
        next = pc + 3 + off;
        break;
      }
      case 0x31: case 0x32: { // JZ / JNZ
        let off = prog[pc + 1] | (prog[pc + 2] << 8);
        if (off >= 32768) off -= 65536;
        sp--;
        if ((op === 0x31) === (b === 0)) next = pc + 3 + off;
        break;
      }
      case 0x33: // CALL, unsigned 16-bit target
        if (cp >= 64) return finish(7);
        calls[cp++] = pc + 3;
        next = prog[pc + 1] | (prog[pc + 2] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return finish(8);
        next = calls[--cp];
        break;
      case 0x40: // LOAD
        if (b < 0 || b > 255) return finish(6);
        stack[sp - 1] = mem[b];
        break;
      case 0x41: // STORE, ( v addr -- )
        if (b < 0 || b > 255) return finish(6);
        mem[b] = a;
        sp -= 2;
        break;
      case 0x50: { // PRINT, decimal ASCII, no newline
        const s = String(b);
        if (out.length + s.length > 65536) return finish(11);
        for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
        sp--;
        break;
      }
      case 0x51: // PUTC, one byte
        if (out.length >= 65536) return finish(11);
        out.push(b & 255);
        sp--;
        break;
      case 0x52: // IN, -1 once the input is used up
        stack[sp++] = inPos < input.length ? input[inPos++] : -1;
        break;
      case 0x53: return finish(b & 255); // EXIT, low byte
    }
    pc = next;
  }
}

// Run every instance in the input directory and write its answers.
for (const id of readdirSync(IN_DIR).sort()) {
  const prog = readFileSync(join(IN_DIR, id, 'program.bin'));
  const input = readFileSync(join(IN_DIR, id, 'input.bin'));
  const { out, exit } = runVm(prog, input);
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'stdout.bin'), out);
  writeFileSync(join(OUT_DIR, id, 'exit.txt'), String(exit) + '\n');
}
