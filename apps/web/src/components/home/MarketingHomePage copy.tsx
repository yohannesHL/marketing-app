"use client";

import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  Container,
  Grid,
  Inline,
  Progress,
  Stack,
  Stepper,
  TextLink,
  Typography,
} from "@launchpad/ui";

export function MarketingHomePage() {
  return (
    <main className="py-16" data-testid="marketing-home">
      <Container>
        <Stack gap={8}>
          <Breadcrumbs items={[{ label: "Workspace", href: "#" }, { label: "Design system foundation" }]} />

          <section data-testid="marketing-hero">
            <Stack gap={4}>
              <Inline>
                <Badge tone="primary">Brand-ready</Badge>
                <Badge tone="success">Storybook-ready</Badge>
              </Inline>
              <Typography as="span" variant="overline">
                Launchpad UI
              </Typography>
              <Typography as="h1" variant="heading-1">
                Shared tokens, primitives, and composition rules for product and marketing work.
              </Typography>
              <Typography className="max-w-3xl" tone="muted">
                The app now consumes the shared `@launchpad/ui` package through workspace imports, using the same foundation that Storybook previews across supported themes and brand palettes.
              </Typography>
              <div data-testid="marketing-cta">
                <Inline>
                  <Button>Explore components</Button>
                  <Button variant="secondary">Open Storybook</Button>
                  <TextLink href="#" standalone>
                    Review brand guide
                  </TextLink>
                </Inline>
              </div>
            </Stack>
          </section>

          <Stepper
            currentStep={1}
            steps={[
              { id: "tokens", title: "Tokens", description: "Theme and brand sources stay isolated." },
              { id: "components", title: "Components", description: "Base inventory ships through @launchpad/ui." },
              { id: "review", title: "Review", description: "Storybook toggles accelerate visual QA." },
            ]}
          />

          <section data-testid="foundation-highlights">
            <Grid minItemWidth="18rem">
              <Card title="Foundation inventory" eyebrow="Base components">
                <Typography tone="muted">Buttons, fields, navigation, overlays, layout primitives, identity components, and accessibility utilities now live in the shared UI package.</Typography>
              </Card>
              <Card title="Theme and brand separation" eyebrow="Typed tokens">
                <Typography tone="muted">Brand color scales are sourced separately from semantic theme definitions so Launchpad can evolve visually without rewriting component logic.</Typography>
              </Card>
              <Card title="Visual workflow" eyebrow="Storybook">
                <Typography tone="muted">Storybook is wired directly to `@launchpad/ui` with toolbar toggles for light/dark themes and multiple brand palettes.</Typography>
              </Card>
            </Grid>
          </section>

          <Alert title="Design-system foundation established" tone="info">
            The shared package now provides a reusable baseline for future product features and marketing-specific composition layers.
          </Alert>

          <Progress label="Foundation rollout" value={72} />
        </Stack>
      </Container>
    </main>
  );
}
