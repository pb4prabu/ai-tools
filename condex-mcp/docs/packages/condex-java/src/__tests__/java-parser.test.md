# java-parser.test.ts — Java Parser & Tagger Tests

**Path:** `packages/condex-java/src/__tests__/java-parser.test.ts`

## What it tests

25+ test cases across 4 describe blocks:

### Java Parser
- Class, interface, method, constructor, field, constant, enum extraction
- Javadoc extraction and cleaning
- Parameter types, return types, throws clause
- Signature generation (everything before `{`)
- Byte offset accuracy
- Content hash generation
- Inner/nested class handling
- Unique symbol ID format

### Spring Tagger
- `@Service` → `SERVICE`
- `@RestController` → `REST_CONTROLLER`
- `@Repository` → `REPOSITORY`
- `@Configuration` → `CONFIGURATION`
- `@SpringBootApplication` → `APPLICATION`
- Unknown annotations → `undefined`

### Architecture Detector
- Hexagonal project detection (from path patterns)
- Layered project detection
- Unknown architecture for ambiguous projects
- Confidence scoring

### Hex Role Tagger
- Port suffix → `INBOUND_PORT` / `OUTBOUND_PORT`
- Adapter suffix → `ADAPTER`
- UseCase in `/application/` → `USE_CASE_HANDLER`
- Classes in `/domain/` → `DOMAIN_ENTITY`
- Events in `/domain/` → `DOMAIN_EVENT`
