# Trademarks

The following names, logos, and visual identifiers are trademarks or
service marks of **Cesvu Limited Company** and are not licensed for use
under the Apache License 2.0 that covers the rest of this
repository. Forks are welcome; misappropriating the marks is not.

This document is informational, not legal advice. The official
trademark registrations and counsel are the source of truth for any
dispute. 

## Reserved marks

The following are reserved to the maximum extent allowable by law
under any jurisdiction that recognizes them:

  - **The name "Cesvu"** and all common variants and stylizations
    thereof, including but not limited to: "Cesvu", "cesvu",
    "cesvu.com", "CEO FYI", "CEO·FYI", "Cesvu!".
  - **The Cesvu logotype and all visual identity assets**, including
    the files logo hosted at cesvu.com.
  - **Any stylized form, color mark, logotype treatment, or
    combination mark** of the above.

## Legal basis

The Apache License 2.0 under which this repository is licensed
already says so, in **Section 6 (Trademarks)**:

> This License does not grant permission to use the trade names,
> trademarks, service marks, or product names of the Licensor,
> except as required for describing the origin of the Work and
> reproducing the content of the NOTICE file.

This document exists to make that reservation explicit, complete,
and discoverable — it does not modify the license grant of the
rest of the repository.

## What you can and can't do

The following table is informal and non-exhaustive. 

| Allowed | Not allowed |
| --- | --- |
| ✅ **Reference the name** in your fork's README, marketing, or documentation to indicate compatibility (e.g. "A community fork of Cesvu, licensed under Apache 2.0"). | ❌ **Use the name as the product or company name for a fork** (e.g. naming your fork "Cesvu-Pro", "Cesvu Cloud", "Cesvu Desktop"). |
| ✅ **Use the name in academic, journalistic, or commentary references** ("based on Cesvu", "the Cesvu format"). | ❌ **Use the logo, logotype, or any visual identity assets** in derivative products, marketing, or your fork's UI. Strip them. |
| ✅ **Use the name in titles, sentences, and headlines** for fair-use commentary and review. | ❌ **Use a confusingly-similar name or mark** that a reasonable user could mistake for the original (e.g. "CEOfy", "CEOEFI", "ceofy.ai", "CesvuX"). |
| ✅ **Quote, link to, and redistribute the unmodified canonical repository** for any non-commercial purpose, with attribution. | ❌ **Register a domain name, social-media handle, app-store listing, or trademark that incorporates or resembles "Cesvu"** in any jurisdiction, in any class of goods or services. |
| ✅ **Submit bug reports, patches, and translations** via the project's normal contribution channels, with attribution. | ❌ **Imply endorsement, certification, or formal partnership** by the project owners. |

Forks MAY use the canonical "Cesvu" name only as a qualifying
suffix in the form: `<Your-Fork-Name>, a fork of Cesvu`. This is
the same convention major open-source projects use (e.g. "TensorFlow
Extended", "Kubernetes Federation") and preserves the canonical
mark's identity at all times.

## Compatibility statements — explicit templates

Saying your software is **"compatible with `.cesvu` files"** is
permitted use of the mark. This is a *nominative* / *descriptive*
reference (Apache 2.0's Section 6 explicitly carves this out: "as
required for describing the origin of the Work") and is the
single most important exception for the open-source ecosystem,
because interoperability claims are how users learn that a tool
can read or write the format.

The following are explicitly permitted (each is a nominative
reference, not an endorsement claim, and they do not create a
confusingly-similar product name):

  - ✅ "Reads `.cesvu` files"
  - ✅ "Writes `.cesvu` files"
  - ✅ "Compatible with the `.cesvu` v1 format"
  - ✅ "Supports the `.cesvu` v1 specification"
  - ✅ "A `.cesvu` reader" / "A `.cesvu` writer"
  - ✅ "Implements the `.cesvu` format"
  - ✅ "`<Your-Product>` is compatible with `.cesvu` files"
  - ✅ "Imports/exports `.cesvu` files"
  - ✅ Naming a file format identifier (`.cesvu` extension, MIME
    type, magic-bytes detector, file-extension association) in your
    product's docs and metadata
  - ✅ Calling out, in benchmarks, marketing, or academic papers,
    that your tool produces or consumes `.cesvu` files

These are nominative uses of the **file format identifier** (the
`.cesvu` string as a *type name*), not of the **product brand**
(Cesvu the application). The line between the two is the
trademark policy's whole point and the reason this section is
explicit: the format is open, the product is not.

The following are explicitly NOT covered by the compatibility-
statements exception, even if they look similar:

  - ❌ Naming your product the "**Cesvu** [something]" (e.g.
    "Cesvu Reader", "Cesvu Lite") — that uses the product brand,
    not the format identifier.
  - ❌ Putting the Cesvu logotype on a compatibility badge. Use
    your own branding; the format identifier is the string
    `.cesvu`, not the logo. 
  - ❌ Saying "**made by** Cesvu" / "**endorsed by** Cesvu" /
    "**official** Cesvu" — that's a false endorsement claim, not
    a compatibility statement.
  - ❌ Implying conformance certification (e.g. "Cesvu-tested"
    or "Cesvu-certified") — there is no conformance-testing
    program, and any such mark is not a nominative reference.
  - ❌ Using "Cesvu" as the name of a product category you
    control (e.g. calling your product line "The Cesvus" or
    "Cesvu-compatible appliances"). That re-uses the brand
    noun, not the format noun.

The short rule: **`<Format>.cesvu` is open; `Brand Cesvu` is
not.** If you can replace "Cesvu" with "PDF" or "ZIP" or
"Parquet" in the sentence and the meaning survives, you're using
the format identifier and the use is permitted. If replacing it
with a generic brand name reads as a product naming or
endorsement claim, you've crossed into a use that needs a
licence.

## Why this file exists

The Apache License 2.0 covers the *code* of this project. The
*name*, the *logo*, and the *visual identity* are separate
intellectual property that the license does not — and was never
intended to — release into the commons. Open-sourcing the code
under Apache 2.0 is a deliberate contribution to the community;
releasing the marks to the commons would be a separate decision,
and is not what was done here.

This file exists so that:

  - Forkers have a single, discoverable place to read the policy.
  - Bad-faith forks (those that copy the name, logo, or visual
    identity to trade on the original project's reputation) can be
    addressed in a single, specific document rather than in scattered
    README mentions.
  - The legal posture is consistent with the license: Apache 2.0
    grants broad code reuse, and this document defines the mark
    boundaries within which that code reuse must stay.

## License

This document is licensed under Apache 2.0; see [`LICENSE`](LICENSE)
for the full license text. (The reserved marks named above are
NOT licensed; the Apache 2.0 license covers the prose of this
document, not the marks it describes.)
