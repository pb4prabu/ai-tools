# spring-tagger.ts — Spring Annotation Role Mapper

**Path:** `packages/cortex-java/src/parser/spring-tagger.ts`

## What it does

Maps Spring Framework annotations to semantic roles. When a class has `@RestController`, it gets tagged as `REST_CONTROLLER` — making it searchable by role.

## Annotation → Role Mapping

| Annotation | Spring Role |
|-----------|-------------|
| `@RestController` | `REST_CONTROLLER` |
| `@Controller` | `CONTROLLER` |
| `@Service` | `SERVICE` |
| `@Repository` | `REPOSITORY` |
| `@Entity` | `ENTITY` |
| `@Configuration` | `CONFIGURATION` |
| `@Component` | `COMPONENT` |
| `@SpringBootApplication` | `APPLICATION` |
| `@ControllerAdvice` | `CONTROLLER_ADVICE` |
| `@EventListener` | `EVENT_LISTENER` |

## Key export

```typescript
assignSpringRole(annotations: string[]) → SpringRole | undefined
```

Returns the first matching role, or `undefined` if no Spring annotations are present.
