import type {
  courseSchema,
  instructorSchema,
  searchQuerySchema,
  searchResultSchema,
} from "$schema";
import type { z } from "@hono/zod-openapi";
import type { database } from "@packages/db";
import { inArray, sql } from "@packages/db/drizzle";
import { unionAll } from "@packages/db/drizzle-pg";
import { course, instructor } from "@packages/db/schema";
import { getFromMapOrThrow } from "@packages/stdlib";
import type { CoursesService } from "./courses";
import type { InstructorsService } from "./instructors";

const COURSES_WEIGHTS = sql`(
  SETWEIGHT(TO_TSVECTOR('english', COALESCE(${course.id}, '')), 'A') ||
  SETWEIGHT(TO_TSVECTOR('english', COALESCE(${course.department}, '')), 'B') ||
  SETWEIGHT(TO_TSVECTOR('english', COALESCE(${course.departmentAlias}, '')), 'B') ||
  SETWEIGHT(TO_TSVECTOR('english', COALESCE(${course.courseNumber}, '')), 'B') ||
  SETWEIGHT(TO_TSVECTOR('english', COALESCE(${course.courseNumeric}::TEXT, '')), 'B') ||
  SETWEIGHT(TO_TSVECTOR('english', COALESCE(${course.title}, '')), 'C') ||
  SETWEIGHT(TO_TSVECTOR('english', COALESCE(${course.description}, '')), 'D')
  )`;

const INSTRUCTORS_WEIGHTS = sql`(
  SETWEIGHT(TO_TSVECTOR('english', COALESCE(${instructor.ucinetid}, '')), 'A') ||
  SETWEIGHT(TO_TSVECTOR('english', COALESCE(${instructor.name}, '')), 'B') ||
  SETWEIGHT(TO_TSVECTOR('english', COALESCE(${instructor.title}, '')), 'B')
  )`;

function splitAtLastNumber(s: string): string {
  const i = Array.from(s.matchAll(/\d+/g))
    .map((x) => x.index)
    .slice(-1)[0];
  return i === undefined ? s : `${s.slice(0, i)} ${s.slice(i)}`.replaceAll(/ {2,}/g, " ");
}

const toQuery = (query: string) =>
  sql`TO_TSQUERY('english', WEBSEARCH_TO_TSQUERY('english', ${splitAtLastNumber(query)})::TEXT || ':*')`;

type SearchServiceInput = z.infer<typeof searchQuerySchema>;

export class SearchService {
  constructor(
    private readonly db: ReturnType<typeof database>,
    private readonly coursesService: CoursesService,
    private readonly instructorsService: InstructorsService,
  ) {}

  async doSearch(input: SearchServiceInput): Promise<z.infer<typeof searchResultSchema>[]> {
    const query = toQuery(input.query);
    const results = await unionAll(
      this.db
        .select({
          id: course.id,
          rank: sql`TS_RANK(${COURSES_WEIGHTS}, ${query})`.mapWith(Number),
        })
        .from(course)
        .where(sql`${COURSES_WEIGHTS} @@ ${query}`),
      this.db
        .select({
          id: instructor.ucinetid,
          rank: sql`TS_RANK(${INSTRUCTORS_WEIGHTS}, ${query})`.mapWith(Number),
        })
        .from(instructor)
        .where(sql`${INSTRUCTORS_WEIGHTS} @@ ${query}`),
    )
      .offset(input.skip)
      .limit(input.take)
      .then((rows) =>
        rows.reduce((acc, row) => acc.set(row.id, row.rank), new Map<string, number>()),
      );
    const courses = await this.coursesService
      .getCoursesRaw({
        where: inArray(course.id, Array.from(results.keys())),
        limit: results.size,
      })
      .then((courses) =>
        courses.reduce(
          (acc, course) => acc.set(course.id, course),
          new Map<string, z.infer<typeof courseSchema>>(),
        ),
      );
    const instructors = await this.instructorsService
      .getInstructorsRaw({
        where: inArray(instructor.ucinetid, Array.from(results.keys())),
        limit: results.size,
      })
      .then((instructors) =>
        instructors.reduce(
          (acc, instructor) => acc.set(instructor.ucinetid, instructor),
          new Map<string, z.infer<typeof instructorSchema>>(),
        ),
      );
    return Array.from(results.keys())
      .map((key) =>
        courses.has(key)
          ? {
              key,
              type: "course" as const,
              result: getFromMapOrThrow(courses, key),
              rank: getFromMapOrThrow(results, key),
            }
          : {
              key,
              type: "instructor" as const,
              result: getFromMapOrThrow(instructors, key),
              rank: getFromMapOrThrow(results, key),
            },
      )
      .toSorted((a, b) => {
        const rankDiff = b.rank - a.rank;
        return Math.abs(rankDiff) < Number.EPSILON
          ? a.key.localeCompare(b.key)
          : Math.sign(rankDiff);
      });
  }
}