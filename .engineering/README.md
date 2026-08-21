# AIRS Agent Engineering Adapter

This adapter was reconciled against the restored AIRS Agent repository at
baseline `ed858c9` before installation.

Key safety choices:

- Database migrations are globally protected and represented by a locked,
  immutable graph node.
- `src/routeTree.gen.ts` is protected generated output.
- `src/components/map/cop-map.tsx` is protected from automated COP UI changes
  because the working MapLibre worker configuration currently lives in that
  same file.
- OpenFreeMap Liberty is treated as explicit operator configuration only.
- Existing Lovable builder dependencies are acknowledged as current technical
  debt and are isolated behind the `builder-integration` node rather than
  silently removed during adapter installation.
- Repair attempts remain capped at two.
- Human promotion and separate push approval remain required.
