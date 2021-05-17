#!/bin/bash

set -ex

cd infrastructure
cdktf destroy --auto-approve infrastructure
