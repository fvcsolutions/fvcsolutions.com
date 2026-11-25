#!/bin/sh
# Apply infra/contact.yaml to the fvcsolutions-contact stack, then upload the contact Lambda's code.
# The form's two keys come from Pipebrain Secrets (project FVCW, env prod) through a 0600 file that
# is deleted on exit, so no value reaches argv, the terminal or the repo.
# Usage: npm run deploy:contact   (needs PIPEBRAIN_TOKEN, `ppb doctor` checks it, and AWS profile FVC)
set -eu

STACK=${STACK:-fvcsolutions-contact}
REGION=us-east-1
: "${AWS_PROFILE:=FVC}"
export AWS_PROFILE

npm test

PARAMS=$(mktemp)
trap 'rm -f "$PARAMS"' EXIT INT TERM
ppb secrets render infra/secret-params.tmpl.json --project FVCW --env prod --out "$PARAMS" >/dev/null
# render skips a deactivated secret silently, leaving its ${NAME} placeholder behind.
if grep -q '\${' "$PARAMS"; then
  echo "A contact form key is missing or deactivated in Pipebrain Secrets (FVCW prod)" >&2
  exit 1
fi

aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file infra/contact.yaml --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset --parameter-overrides "file://$PARAMS"

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
FUNCTION=$(output ContactFunctionName)

# The Lambda, bundled with altcha-lib into one file. The AWS SDK comes with the runtime.
rm -rf build/contact
mkdir -p build/contact
node_modules/.bin/esbuild functions/contact/handler.mjs --bundle --platform=node --target=node22 \
  --format=esm '--external:@aws-sdk/*' --outfile=build/contact/index.mjs --log-level=warning
(cd build/contact && zip -q -X ../contact.zip index.mjs)
aws lambda update-function-code --region "$REGION" --function-name "$FUNCTION" \
  --zip-file fileb://build/contact.zip --query LastUpdateStatus --output text
aws lambda wait function-updated-v2 --region "$REGION" --function-name "$FUNCTION"

echo "Contact endpoint: $(output ContactUrl) (site.json contact.endpoint must match, without the trailing slash)"
