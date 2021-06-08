#!/bin/bash

set -ex

cd infrastructure
cdktf apply --auto-approve infrastructure
cdktf apply --auto-approve baseline
cdktf apply --auto-approve development
cdktf apply --auto-approve staging
cdktf apply --auto-approve production
