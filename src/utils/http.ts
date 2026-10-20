import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Erreur métier renvoyée telle quelle au client, avec son code HTTP (et un code lisible par l'app si besoin). */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Fait suivre les erreurs des contrôleurs async au gestionnaire d'erreurs d'Express 4. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
