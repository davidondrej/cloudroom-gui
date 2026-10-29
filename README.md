# Cloudroom moved to [davidondrej/cloudroom](https://github.com/davidondrej/cloudroom)

The app now lives in one open-source repo with the core and skills. Its code is still in `gui/`. This repo is archived and read-only.

- **Download:** [cloudroom.dev/download](https://www.cloudroom.dev/download). Apps up to v128 update through this repo's releases, which stay up.
- **Issues:** open issues moved to the new repo. Their old links redirect.
- **Forks and pull requests:** the new repo includes this repo's full history, so your commits carry over:

    ```bash
    git remote add cloudroom https://github.com/davidondrej/cloudroom.git   # or point your upstream remote there
    git fetch cloudroom
    git switch -c my-change cloudroom/main
    git cherry-pick <your commits>
    ```

    Then [fork davidondrej/cloudroom](https://github.com/davidondrej/cloudroom/fork), push the branch there, and open the PR. A fork of this repo can't open PRs on the new one.
