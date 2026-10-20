import type { NextFunction, Request, Response } from 'express';
import { z, type ZodSchema } from 'zod';

export const validateRequest =
  (schema: ZodSchema) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse({ body: req.body, query: req.query, params: req.params });
    if (parsed.success) {
      // On garde la version nettoyée (email en minuscules, espaces retirés…).
      if (parsed.data.body !== undefined) req.body = parsed.data.body;
      next();
      return;
    }
    res.status(400).json({ message: 'Validation échouée', error: parsed.error.errors.map(({ message }: z.ZodIssue) => message).join(', ') });
  };
