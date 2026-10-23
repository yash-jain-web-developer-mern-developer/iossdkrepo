# OpenRTB conformance check

Validates the OpenRTB 2.6 messages MobiAd sends and returns against the **prebid/openrtb** Go library (strict decoding: unknown fields are errors).

```bash
node gen.mjs            # writes requests.json (what we send to partners) and responses.json (what our bidder returns)
docker run --rm -v "$PWD":/w -w /w golang:1.22 sh -c 'go mod init rtbv; go get github.com/prebid/openrtb/v20@latest; go run . app_x'   # strict validation + builds go-request.json
node post.mjs           # posts the library-built request to our bidder endpoint (an in-process test server)
```
This found one real bug (a non-standard `app.content.kidsdirected` field), now fixed. It proves *schema conformance*, not interoperability with a particular exchange.
