import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  // bodyParser: false — we install express.json() ourselves below with a
  // `verify` hook so every request carries req.rawBody (the exact bytes
  // received) alongside the normally-parsed req.body. Webhook signature
  // verification (Paystack/Flutterwave, see PaymentsController) MUST check
  // against the original bytes, not a re-serialized JSON.stringify(req.body)
  // — those can differ (key order, whitespace, number formatting) and a
  // mismatch there would make every real webhook fail signature checks.
  // This was a known TODO (backend/README.md "What's stubbed") — fixed here
  // rather than left as a per-route raw-body middleware, so it protects any
  // future webhook route too, not just the two that exist today.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  app.use(
    json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(
    helmet({
      // The web app (localhost:3001) and the API (localhost:3000) are
      // different origins in dev (and different subdomains/hosts in prod).
      // Helmet's default Cross-Origin-Resource-Policy: same-origin blocks
      // the browser from reading *any* cross-origin fetch response — even
      // ones CORS itself allows — which made every apiFetch() call in the
      // web app fail with "Failed to fetch" / net::ERR_BLOCKED_BY_CLIENT
      // despite enableCors() below being configured correctly.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.enableCors({ origin: true, credentials: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`PAYDER API listening on port ${port}`);
}

bootstrap();
