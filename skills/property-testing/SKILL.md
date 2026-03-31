---
name: property-testing
description: Property-based testing patterns — when and how to write property tests alongside unit tests. Preloaded into the implementer agent.
user-invocable: false
---

# Property-Based Testing

This skill is preloaded into the implementer. Use it when writing tests for functions that involve calculation, transformation, or invariant logic.

## When to Use Property Tests

Write property tests when the function:
- Performs arithmetic or financial calculations
- Transforms data (parse/serialize, encode/decode, format/unformat)
- Has documented invariants (conservation laws, bounds, ordering)
- Processes collections (sort, filter, aggregate)

Skip property tests for:
- Simple getters/setters
- UI-only logic (styling, layout)
- CRUD operations with no business logic
- Functions that are thin wrappers around library calls

## Libraries

- **TypeScript**: `fast-check` — use `fc.assert(fc.property(...))` inside `it()` blocks
- **Python**: `hypothesis` — use `@given(...)` decorator on test functions

## Property Patterns

### Roundtrip (encode/decode)
```typescript
fc.assert(fc.property(arbInput, (input) => {
  expect(decode(encode(input))).toEqual(input);
}));
```

### Conservation (transfer, split, merge)
```typescript
// Total is preserved across a transfer
fc.assert(fc.property(arbA, arbB, arbAmount, (a, b, amount) => {
  const totalBefore = balance(a) + balance(b);
  const totalAfter = balance(transfer(a, b, amount));
  expect(Math.abs(totalAfter - totalBefore)).toBeLessThan(1e-6);
}));
```

### Idempotence (normalize, format)
```typescript
fc.assert(fc.property(arbInput, (input) => {
  expect(normalize(normalize(input))).toEqual(normalize(input));
}));
```

### No-crash-on-valid-input
```typescript
fc.assert(fc.property(arbValidInput, (input) => {
  const result = myFunction(input);
  expect(Number.isFinite(result)).toBe(true); // no NaN, no Infinity
}));
```

### Bounds / Invariants
```typescript
// Output is always within expected range
fc.assert(fc.property(arbInput, (input) => {
  const result = myFunction(input);
  expect(result).toBeGreaterThanOrEqual(0);
  expect(result).toBeLessThanOrEqual(MAX);
}));
```

## fast-check Tips

- Use `{ numRuns: 1000 }` minimum for meaningful coverage
- Use `noNaN: true, noDefaultInfinity: true` in `fc.double()` for financial math
- Use `Math.round()` for millisecond-to-day conversions to avoid DST drift
- For floating-point comparisons, use `1e-6` tolerance (not `1e-10` — too tight for large values)
- Name your arbitraries: `const arbTransaction = fc.record({...})`

## Regression Test Rule

Every bug fix MUST include a regression test that reproduces the pre-fix scenario. Format:

```typescript
// Regression: <commit-hash> — <one-line description of the bug>
it("description of what used to fail", () => {
  // Arrange: reproduce the conditions that triggered the bug
  // Act: call the function
  // Assert: verify the fix holds
});
```

## File Naming

- Property tests: `foo.property.test.ts` (next to `foo.ts`)
- Regression tests: `regression.test.ts` (one per module or `src/lib/regression.test.ts` for cross-cutting)
