/**
 * Trigger a trend/dish/experience recompute.
 *
 *   npx tsx scripts/recompute.ts                              # localhost
 *   npx tsx scripts/recompute.ts --url https://you.vercel.app
 *
 * Needs PIPELINE_SECRET (or CRON_SECRET) in the environment — the same secret
 * the scheduled job uses. Reads only our own tables.
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf('--url');
  return {
    baseUrl:
      urlIndex >= 0 && args[urlIndex + 1]
        ? args[urlIndex + 1]
        : process.env.PIPELINE_BASE_URL ?? 'http://localhost:3000',
  };
}

async function main() {
  const { baseUrl } = parseArgs();
  const secret = process.env.CRON_SECRET ?? process.env.PIPELINE_SECRET;

  if (!secret) {
    console.error(
      'Set PIPELINE_SECRET (or CRON_SECRET) first — it is the same value the ' +
        'scheduled job authenticates with.'
    );
    process.exit(1);
  }

  console.log(`Recomputing via ${baseUrl}/api/cron/recompute …`);

  const response = await fetch(`${baseUrl}/api/cron/recompute`, {
    headers: { Authorization: `Bearer ${secret}` },
  });

  const body: any = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error(`Failed (${response.status}):`, body.error ?? body);
    process.exit(1);
  }

  console.log('\n── Recompute summary ──');
  console.log(`  window:            ${body.windowDays} days`);
  console.log(`  min observations:  ${body.minObservations}`);
  console.log(
    `  dishes synced:     ${body.dishes?.dishesLinked} link(s) across ` +
      `${body.dishes?.restaurants} restaurant(s), ${body.dishes?.mentionsRecorded} mention(s)`
  );
  console.log(
    `  restaurant trends: ${body.restaurantTrends?.ranked} ranked, ` +
      `${body.restaurantTrends?.warmingUp} warming up, ` +
      `${body.restaurantTrends?.insufficient} insufficient ` +
      `(of ${body.restaurantTrends?.evaluated})`
  );
  console.log(
    `  dish trends:       ${body.dishTrends?.ranked} ranked of ${body.dishTrends?.evaluated}`
  );
  console.log(
    `  experience:        ${body.experience?.measured} measured, ` +
      `${body.experience?.insufficient} insufficient ` +
      `(of ${body.experience?.evaluated})`
  );

  if (body.restaurantTrends?.ranked === 0) {
    console.log(
      `\nNothing is ranked yet. That is correct, not a bug: no restaurant has ` +
        `reached ${body.minObservations} signals in the last ${body.windowDays} ` +
        `days. The app shows "Gaining attention" / "Not enough data" instead of ` +
        `inventing a ranking.`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
