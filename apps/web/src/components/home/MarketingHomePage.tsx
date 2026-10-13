"use client";

import Link from "next/link";

import {
  Alert,
  Badge,
  Card,
  Container,
  Grid,
  Inline,
  Stack,
  Typography,
} from "@launchpad/ui";

export function MarketingHomePage() {
  return (
    <main className="py-16" data-testid="marketing-home">
      <Container>
        <Stack gap={8}>
          <section data-testid="marketing-hero">
            <Stack gap={5}>
              <Inline>
                <Badge tone="primary">Official homepage</Badge>
                <Badge tone="success">Campaign creation</Badge>
              </Inline>
              <Typography as="span" variant="overline">
                Launchpad
              </Typography>
              <Typography as="h1" variant="heading-1">
                Launch campaigns with confidence.
              </Typography>
              <Typography className="max-w-3xl" tone="muted">
                Go from campaign intent to launch-ready creative with guided planning, transparent estimates, and a final review that keeps every choice visible before you publish.
              </Typography>
              <div data-testid="marketing-cta">
                <Inline>
                  <Link className="btn normal-case shadow-soft btn-primary" href="/campaigns/create">
                    Open campaign wizard
                  </Link>
                  <Link className="btn normal-case shadow-soft btn-secondary" href="/connections">
                    Manage connections
                  </Link>
                  <Link className="btn normal-case shadow-soft btn-ghost" href="/sign-in">
                    Sign in
                  </Link>
                  <Link className="btn normal-case shadow-soft btn-secondary" href="#homepage-highlights">
                    See how it works
                  </Link>
                </Inline>
              </div>
            </Stack>
          </section>

          <section data-testid="homepage-highlights" id="homepage-highlights">
            <Grid minItemWidth="18rem">
              <Card title="Goal-first planning" eyebrow="Step 1">
                <Typography tone="muted">
                  Start with the campaign objective and get strategy guidance before you move into targeting and budget decisions.
                </Typography>
              </Card>
              <Card title="Audience clarity" eyebrow="Steps 2-3">
                <Typography tone="muted">
                  Shape audience targeting, upload custom audiences, and review stable size and reach estimates as the plan changes.
                </Typography>
              </Card>
              <Card title="Launch review" eyebrow="Steps 4-6">
                <Typography tone="muted">
                  Generate editable creative, compare platforms, and confirm the full campaign summary before launch submission.
                </Typography>
              </Card>
            </Grid>
          </section>

          <Alert title="Primary path to campaign creation" tone="info">
            The homepage now directs users to the multi-step campaign wizard so the main product workflow starts immediately.
          </Alert>
        </Stack>
      </Container>
    </main>
  );
}
