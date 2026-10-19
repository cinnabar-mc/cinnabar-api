# Repository agent instructions

The private cinnabar-mc/cinnabar-cosmetics repository owns original cosmetic and
emote authoring, exports, runtime objects, catalog checks and R2 publication.
Keep geometries, animations, textures and embedded authoring projects out of this
public repository. Public tests use synthetic fixtures and the shared schema.

The API owns catalog delivery and database entitlements. Ownership belongs in the
Hub cosmetic_entitlements table, never in username or XUID allowlists in code.
Preserve the original free metadata fallback and the existing digest asset URLs.
Public builds and tests must work without access to the private asset repository.
Preserve artwork license notices. Document the contract of new helper functions.
